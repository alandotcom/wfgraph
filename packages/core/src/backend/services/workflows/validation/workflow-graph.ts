import {
  getSerializedWorkflowGraphError,
  isSerializedWorkflowGraph,
  parseSerializedWorkflowGraph,
  toWorkflowGraphData,
  WORKFLOW_GRAPH_OPTIONS,
} from "@wfgraph/shared/graph/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@wfgraph/shared/graph/types";
import { workflowTopologyRefusalReason } from "@wfgraph/shared/graph/workflow-topology";

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

/** What a refusal calls a node: the builder's label, or its id as a fallback. */
export function getNodeLabel(node: WorkflowNode): string {
  return node.data.label?.trim() || node.id;
}

export type WorkflowGraphValidationResult =
  | {
      valid: true;
      graph: SerializedWorkflowGraph;
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
    }
  | {
      valid: false;
      error: string;
    };

export function normalizeWorkflowGraph(
  graph: SerializedWorkflowGraph
): SerializedWorkflowGraph {
  return {
    ...graph,
    options: {
      allowSelfLoops: WORKFLOW_GRAPH_OPTIONS.allowSelfLoops,
      multi: WORKFLOW_GRAPH_OPTIONS.multi,
      type: WORKFLOW_GRAPH_OPTIONS.type,
    },
  };
}

export function validateWorkflowGraph(
  graph: unknown
): WorkflowGraphValidationResult {
  if (!isSerializedWorkflowGraph(graph)) {
    return {
      valid: false,
      error: getSerializedWorkflowGraphError(graph) || "Invalid graph payload",
    };
  }

  const parsedGraph = parseSerializedWorkflowGraph(graph);

  const nodeKeys = parsedGraph.nodes.map((node) => node.key);
  if (hasDuplicates(nodeKeys)) {
    return {
      valid: false,
      error: "Graph contains duplicate node IDs",
    };
  }

  const edgeKeys = parsedGraph.edges.map((edge) => edge.key);
  if (hasDuplicates(edgeKeys)) {
    return {
      valid: false,
      error: "Graph contains duplicate edge IDs",
    };
  }

  const normalizedGraph = normalizeWorkflowGraph(parsedGraph);

  let graphData: { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
  try {
    graphData = toWorkflowGraphData(normalizedGraph);
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid graph payload",
    };
  }

  const topologyError = workflowTopologyRefusalReason(graphData);
  if (topologyError) {
    return {
      valid: false,
      error: topologyError,
    };
  }

  return {
    valid: true,
    graph: normalizedGraph,
    nodes: graphData.nodes,
    edges: graphData.edges,
  };
}
