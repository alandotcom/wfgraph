import type { SavedWorkflow } from "#src/lib/rpc-client";

/** A server response with only the fields the save store and its callers read. */
export function savedWorkflow(id: string): SavedWorkflow {
  return {
    id,
    name: id,
    graph: { nodes: [], edges: [] },
    nodes: [],
    edges: [],
    isPaused: false,
    mode: "live",
    visibility: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
