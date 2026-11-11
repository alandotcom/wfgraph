/**
 * Whether a draft read back from the server stores a graph the editor sent.
 * The save queue asks this after a request whose answer it never got, to tell
 * its own committed write from a write made elsewhere.
 */

import { sortBy } from "es-toolkit/array";
import { isEqual } from "es-toolkit/predicate";
import {
  type SavedWorkflow,
  toEditorGraph,
  toSerializedGraph,
} from "#src/lib/rpc-client";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

type EditorGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

/**
 * The graph as plain JSON in id order. JSON drops a key holding `undefined`,
 * which the wire drops too, and the order a graph lists its nodes in carries
 * no meaning.
 */
function comparableGraph(graph: EditorGraph): unknown {
  const ordered = {
    nodes: sortBy(graph.nodes, [(node) => node.id]),
    edges: sortBy(graph.edges, [(edge) => edge.id]),
  };
  const json: unknown = JSON.parse(JSON.stringify(ordered));
  return json;
}

/**
 * True when `stored` holds exactly `sent`, node positions included. `sent` goes
 * through the serialization a save sends and the parse a load runs, so the
 * fields a save drops (the `add` placeholder, selection, run annotations) and
 * the normalization a load applies count the same on both sides.
 */
export function storedDraftHoldsGraph(
  stored: SavedWorkflow,
  sent: EditorGraph
): boolean {
  return isEqual(
    comparableGraph({ nodes: stored.nodes, edges: stored.edges }),
    comparableGraph(toEditorGraph(toSerializedGraph(sent)))
  );
}
