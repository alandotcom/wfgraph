/**
 * Private graph cells. Mutations go through the store atoms so undo always
 * sees them. Importing these from a component would let a write skip history.
 */

import type { Getter, Setter } from "jotai";
import { atom } from "jotai";
import { orderGroupParentsFirst } from "@wfgraph/shared/graph/node-group";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { isReviewOpenAtom } from "#src/lib/workflow-review-store";
import { saveWorkflowAtom } from "#src/lib/workflow-save-store";
import {
  singleSelectedEdgeId,
  singleSelectedNodeId,
} from "#src/lib/canvas-selection";
import { activeSelectionAtom } from "#src/lib/workflow-workspace-navigation";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export const nodesStateAtom = atom<WorkflowNode[]>([]);
export const edgesStateAtom = atom<WorkflowEdge[]>([]);

/**
 * A run's pinned graph, and the node the run stopped at: where it failed, the
 * Wait it is parked on, or where it was canceled. Null for a run that is still
 * moving or that completed.
 */
type PinnedRunGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  stoppedNodeId: string | null;
};

const pinnedRunGraphAtom = atom<PinnedRunGraph | null>(null);

/**
 * The published graph a selected run pinned, shown on the canvas instead of the
 * draft so node statuses land on the shape the run actually walked. Cleared
 * when the run is deselected. Never saved: draft atoms stay draft-only so a
 * Cmd+S or toolbar save cannot persist the run graph over the editor's draft.
 *
 * Reads as null outside Runs, on the same route address
 * `selectedExecutionIdAtom` reads, because the two describe one run and must go
 * off the canvas together. `ExecutionOverlaySync` clears the write side when
 * the route closes the run.
 */
export const executionOverlayGraphAtom = atom(
  (get) =>
    get(workflowWorkspaceViewAtom) === "runs" ? get(pinnedRunGraphAtom) : null,
  (
    _get,
    set,
    graph: {
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      stoppedNodeId?: string | null | undefined;
    } | null
  ) => {
    set(
      pinnedRunGraphAtom,
      graph === null
        ? null
        : {
            nodes: orderGroupParentsFirst(graph.nodes),
            edges: graph.edges,
            stoppedNodeId: graph.stoppedNodeId ?? null,
          }
    );
  }
);

/**
 * The selected node of the active workspace address when the selection is
 * exactly that one node, otherwise null. `activeSelectionAtom` holds the whole
 * selection, including a multi-selection.
 */
export const selectedNodeAtom = atom((get) =>
  singleSelectedNodeId(get(activeSelectionAtom))
);

/** The selected edge when the selection is exactly that one edge. */
export const selectedEdgeAtom = atom((get) =>
  singleSelectedEdgeId(get(activeSelectionAtom))
);

type HistoryState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export const historyAtom = atom<HistoryState[]>([]);
export const futureAtom = atom<HistoryState[]>([]);

const HISTORY_LIMIT = 50;

/** Refuse draft mutations while a read-only display graph owns the canvas. */
export function draftEditable(get: Getter): boolean {
  return get(workflowWorkspaceViewAtom) === "draft" && !get(isReviewOpenAtom);
}

/** Snapshot the graph so the next change is undoable, and drop any redo branch. */
export function pushHistory(get: Getter, set: Setter) {
  const snapshot: HistoryState = {
    nodes: get(nodesStateAtom),
    edges: get(edgesStateAtom),
  };
  const history = [...get(historyAtom), snapshot];

  set(historyAtom, history.slice(-HISTORY_LIMIT));
  set(futureAtom, []);
}

export function requestGraphSave(
  get: Getter,
  set: Setter,
  options?: { immediate?: boolean }
) {
  void set(
    saveWorkflowAtom,
    { nodes: get(nodesStateAtom), edges: get(edgesStateAtom) },
    options
  );
}
