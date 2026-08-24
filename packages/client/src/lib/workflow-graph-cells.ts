/**
 * Private graph cells. Mutations go through the store atoms so undo always
 * sees them. Importing these from a component would let a write skip history.
 */

import type { Getter, Setter } from "jotai";
import { atom } from "jotai";
import { orderGroupParentsFirst } from "@wfgraph/shared/graph/node-group";
import { activePropertiesTabAtom } from "#src/lib/workflow-ui-store";
import {
  isComparisonActiveAtom,
  isComparisonPendingAtom,
} from "#src/lib/workflow-comparison-store";
import { isPublicationReviewActiveAtom } from "#src/lib/workflow-publication-review-store";
import { saveWorkflowAtom } from "#src/lib/workflow-save-store";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export const nodesStateAtom = atom<WorkflowNode[]>([]);
export const edgesStateAtom = atom<WorkflowEdge[]>([]);

const pinnedRunGraphAtom = atom<{
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} | null>(null);

/**
 * The published graph a selected run pinned, shown on the canvas instead of the
 * draft so node statuses land on the shape the run actually walked. Cleared
 * when the run is deselected. Never saved: draft atoms stay draft-only so a
 * Cmd+S or toolbar save cannot persist the run graph over the editor's draft.
 *
 * Reads as null while the Runs tab is down, on the same `activePropertiesTabAtom`
 * gate `selectedExecutionIdAtom` reads through, because the two describe one run
 * and must go off the canvas together. This gate covers the one exit that keeps
 * the run open on purpose: the tab bar's Properties button, which writes the tab
 * and not the URL, so coming back paints the same run again without a refetch.
 * An interaction that hides the whole surface instead clears the search through
 * `useLeaveRunsSurface`, and `ExecutionOverlaySync` nulls the write side.
 */
export const executionOverlayGraphAtom = atom(
  (get) =>
    get(activePropertiesTabAtom) === "runs" ? get(pinnedRunGraphAtom) : null,
  (
    _get,
    set,
    graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } | null
  ) => {
    set(
      pinnedRunGraphAtom,
      graph === null
        ? null
        : {
            nodes: orderGroupParentsFirst(graph.nodes),
            edges: graph.edges,
          }
    );
  }
);

export const selectedNodeAtom = atom<string | null>(null);
export const selectedEdgeAtom = atom<string | null>(null);

type HistoryState = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export const historyAtom = atom<HistoryState[]>([]);
export const futureAtom = atom<HistoryState[]>([]);

const HISTORY_LIMIT = 50;

/** Refuse draft mutations while a read-only display graph owns the canvas. */
export function draftEditable(get: Getter): boolean {
  return (
    get(executionOverlayGraphAtom) === null &&
    !get(isComparisonActiveAtom) &&
    !get(isComparisonPendingAtom) &&
    !get(isPublicationReviewActiveAtom)
  );
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
