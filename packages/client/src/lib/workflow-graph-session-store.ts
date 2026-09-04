/**
 * Owns transitions that replace the editable graph as one workflow session.
 * Ordinary node and edge mutations remain in `workflow-graph-store`; session
 * transitions reset graph-local history and protect browser work from stale
 * route, restore, and remote-draft responses.
 */

import type { Getter } from "jotai";
import { atom } from "jotai";
import { orderGroupParentsFirst } from "@wfgraph/shared/graph/node-group";
import type { SavedWorkflow } from "#src/lib/rpc-client";
import {
  currentWorkflowDraftRevisionAtom,
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
  currentWorkflowNameAtom,
  currentWorkflowVisibilityAtom,
  hasUnsavedChangesAtom,
  isSavingAtom,
  lastSavedAtAtom,
  recordLoadedDraftRevisionAtom,
  successfulSaveGenerationAtom,
  workflowLoadErrorAtom,
  workflowNotFoundAtom,
} from "#src/lib/workflow-save-store";
import {
  activeAgentTurnIdAtom,
  isGeneratingAtom,
  selectedExecutionIdAtom,
  workflowGraphUpdateAtom,
  workflowWorkspaceViewAtom,
} from "#src/lib/workflow-ui-store";
import { clearPublicationReviewAtom } from "#src/lib/workflow-publication-review-store";
import {
  draftEditable,
  edgesStateAtom,
  executionOverlayGraphAtom,
  futureAtom,
  historyAtom,
  nodesStateAtom,
  selectedEdgeAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-cells";
import { clearWorkflowComparisonAtom } from "#src/lib/workflow-comparison-store";
import { resetNodeStatusesAtom as resetPresentationNodeStatusesAtom } from "#src/lib/workflow-graph-presentation-store";
import { NO_ISSUES, workflowIssuesAtom } from "#src/lib/workflow-issues-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/** Lets the config panel focus a node that has not received an action type yet. */
export const newlyCreatedNodeIdAtom = atom<string | null>(null);
/** Keeps one pointer drag as one undoable graph change. */
export const workflowDragActiveAtom = atom(false);

export type RemoteWorkflowUpdateDisposition = "install" | "conflict" | "defer";

export type ObservedRemoteDraftRevision = {
  workflowId: string;
  draftRevision: number;
};

const observedRemoteDraftRevisionStateAtom =
  atom<ObservedRemoteDraftRevision | null>(null);

export const observedRemoteDraftRevisionAtom = atom((get) =>
  get(observedRemoteDraftRevisionStateAtom)
);

/** Keep the newest revision event seen for the current workflow session. */
export const recordObservedRemoteDraftRevisionAtom = atom(
  null,
  (get, set, event: ObservedRemoteDraftRevision) => {
    const current = get(observedRemoteDraftRevisionStateAtom);
    if (
      current?.workflowId === event.workflowId &&
      current.draftRevision >= event.draftRevision
    ) {
      return;
    }
    set(observedRemoteDraftRevisionStateAtom, event);
  }
);

function remoteWorkflowUpdateDisposition(
  get: Getter
): RemoteWorkflowUpdateDisposition {
  const browserWorkIsIdle =
    !get(isSavingAtom) &&
    get(activeAgentTurnIdAtom) === null &&
    !get(isGeneratingAtom);

  if (browserWorkIsIdle && get(hasUnsavedChangesAtom) && draftEditable(get)) {
    return "conflict";
  }

  if (
    browserWorkIsIdle &&
    !get(hasUnsavedChangesAtom) &&
    !get(workflowDragActiveAtom) &&
    draftEditable(get)
  ) {
    return "install";
  }

  return "defer";
}

/** Decide whether a newer persisted draft can install, must prompt, or must wait. */
export const remoteWorkflowUpdateDispositionAtom = atom((get) =>
  remoteWorkflowUpdateDisposition(get)
);

/** A newer persisted draft that browser edits currently prevent loading. */
export const remoteDraftChangeAtom = atom((get) => {
  const observed = get(observedRemoteDraftRevisionStateAtom);
  return observed?.workflowId === get(currentWorkflowIdAtom) &&
    observed.draftRevision > get(currentWorkflowDraftRevisionAtom) &&
    remoteWorkflowUpdateDisposition(get) === "conflict"
    ? observed
    : null;
});

/** End transient pointer state when the workflow editor leaves the page. */
export const endWorkflowEditorLifetimeAtom = atom(null, (_get, set) => {
  set(workflowDragActiveAtom, false);
});

/** Replace the graph and clear state that belongs to the previous graph. */
export const loadWorkflowGraphAtom = atom(
  null,
  (get, set, graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) => {
    const workflowId = get(currentWorkflowIdAtom);
    if (workflowId) {
      set(clearWorkflowComparisonAtom, workflowId);
    }
    set(nodesStateAtom, orderGroupParentsFirst(graph.nodes));
    set(edgesStateAtom, graph.edges);
    set(historyAtom, []);
    set(futureAtom, []);
    set(workflowDragActiveAtom, false);
    set(selectedNodeAtom, null);
    set(selectedEdgeAtom, null);
    set(newlyCreatedNodeIdAtom, null);
    set(hasUnsavedChangesAtom, false);
    set(workflowIssuesAtom, NO_ISSUES);
  }
);

/** Put a persisted workflow and its editor identity into the current session. */
export const hydrateWorkflowAtom = atom(
  null,
  (get, set, workflow: SavedWorkflow & { saveGeneration?: number }) => {
    if (
      workflow.saveGeneration !== undefined &&
      (get(successfulSaveGenerationAtom).get(workflow.id) ?? 0) >
        workflow.saveGeneration
    ) {
      return;
    }

    set(clearWorkflowComparisonAtom, workflow.id);
    set(clearPublicationReviewAtom);
    const nodes = workflow.nodes.map((node) => ({
      ...node,
      selected: false,
    }));
    const clientIsAheadOfServer =
      get(currentWorkflowIdAtom) === workflow.id &&
      (get(hasUnsavedChangesAtom) ||
        get(isSavingAtom) ||
        get(workflowDragActiveAtom));

    if (!clientIsAheadOfServer) {
      set(loadWorkflowGraphAtom, { nodes, edges: workflow.edges });
      set(recordLoadedDraftRevisionAtom, {
        workflowId: workflow.id,
        draftRevision: workflow.draftRevision,
      });
      set(observedRemoteDraftRevisionStateAtom, null);
    }

    if (get(currentWorkflowIdAtom) !== workflow.id) {
      const preserveDeepLinkedRun =
        get(workflowWorkspaceViewAtom) === "runs" &&
        get(selectedExecutionIdAtom) !== null;
      set(resetPresentationNodeStatusesAtom);
      set(executionOverlayGraphAtom, null);
      set(selectedExecutionIdAtom, null);
      set(workflowWorkspaceViewAtom, preserveDeepLinkedRun ? "runs" : "draft");
    }
    set(activeAgentTurnIdAtom, null);
    set(isGeneratingAtom, false);
    set(currentWorkflowIdAtom, workflow.id);
    set(currentWorkflowNameAtom, workflow.name);
    set(lastSavedAtAtom, null);
    set(currentWorkflowVisibilityAtom, workflow.visibility ?? "private");
    set(currentWorkflowModeAtom, workflow.mode ?? "live");
    set(workflowNotFoundAtom, false);
    set(workflowLoadErrorAtom, null);
  }
);

/** Install a newer persisted draft only when the browser session can yield. */
export const installRemoteWorkflowAtom = atom(
  null,
  (get, set, workflow: SavedWorkflow) => {
    if (
      workflow.id !== get(currentWorkflowIdAtom) ||
      workflow.draftRevision <= get(currentWorkflowDraftRevisionAtom) ||
      remoteWorkflowUpdateDisposition(get) !== "install"
    ) {
      return false;
    }

    set(hydrateWorkflowAtom, workflow);
    set(workflowGraphUpdateAtom, {
      workflowId: workflow.id,
      revision: (get(workflowGraphUpdateAtom)?.revision ?? 0) + 1,
    });
    return true;
  }
);

/** Install a restored graph only while its workflow still owns the editor. */
export const installRestoredWorkflowAtom = atom(
  null,
  (
    get,
    set,
    input: { expectedWorkflowId: string; workflow: SavedWorkflow }
  ) => {
    if (
      get(currentWorkflowIdAtom) !== input.expectedWorkflowId ||
      input.workflow.id !== input.expectedWorkflowId
    ) {
      return false;
    }
    set(loadWorkflowGraphAtom, {
      nodes: input.workflow.nodes,
      edges: input.workflow.edges,
    });
    set(recordLoadedDraftRevisionAtom, {
      workflowId: input.workflow.id,
      draftRevision: input.workflow.draftRevision,
    });
    return true;
  }
);
