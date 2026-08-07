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
