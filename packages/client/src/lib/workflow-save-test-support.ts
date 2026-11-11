import type { SavedWorkflow } from "#src/lib/rpc-client";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/** A server response with only the fields the save store and its callers read. */
export function savedWorkflow(
  id: string,
  graph?: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
): SavedWorkflow {
  return {
    id,
    name: id,
    draftRevision: 1,
    graph: { nodes: [], edges: [] },
    nodes: graph?.nodes ?? [],
    edges: graph?.edges ?? [],
    isPaused: false,
    mode: "live",
    visibility: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasUnpublishedChanges: false,
  };
}

/**
 * A draft read-back that fails, as it does while the network is down. The save
 * queue reads the draft back only after a request with no usable answer or a
 * draft conflict, so a case about neither never observes it.
 */
export function unreadableDraft(_workflowId: string): Promise<SavedWorkflow> {
  return Promise.reject(new Error("The draft read-back is not under test"));
}
