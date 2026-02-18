import { hasCycle } from "graphology-dag";
import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "@/shared/workflow/condition-branch";
import {
  createGraphFromSerialized,
  getNodeTypeFromSerializedNode,
  getSerializedWorkflowGraphError,
  isSerializedWorkflowGraph,
  parseSerializedWorkflowGraph,
  toWorkflowGraphData,
  WORKFLOW_GRAPH_OPTIONS,
} from "@/shared/workflow/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowEdge,
  WorkflowNode,
} from "@/shared/workflow/types";

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function hasRootTrigger(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): boolean {
  const incoming = new Set(input.edges.map((edge) => edge.target));
  return input.nodes.some(
    (node) => node.data.type === "trigger" && !incoming.has(node.id)
  );
}

function getNodeLabel(node: WorkflowNode): string {
  return node.data.label?.trim() || node.id;
}

function validateConditionBranchEdges(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): string | null {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));

  for (const edge of input.edges) {
    const sourceNode = nodeById.get(edge.source);
    if (!sourceNode) {
      continue;
    }

    const sourceIsCondition = isConditionActionNode(sourceNode);
    const branch = normalizeConditionBranch(edge.sourceHandle);

    if (sourceIsCondition) {
      const hasExplicitBranch =
        edge.sourceHandle === "true" || edge.sourceHandle === "false";
      if (!hasExplicitBranch) {
        return `Condition node "${getNodeLabel(sourceNode)}" has edge "${edge.id}" without explicit sourceHandle "true" or "false"`;
      }
      continue;
    }

    if (branch) {
      return `Only Condition nodes can emit true/false branch edges (edge "${edge.id}")`;
    }
  }

  return null;
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

  const nodeKeySet = new Set(nodeKeys);
  for (const edge of parsedGraph.edges) {
    if (!(nodeKeySet.has(edge.source) && nodeKeySet.has(edge.target))) {
      return {
        valid: false,
        error: "Graph contains edges with missing source/target nodes",
      };
    }

    if (edge.source === edge.target) {
      return {
        valid: false,
        error: "Graph cannot contain self-loops",
      };
    }
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

  try {
    const graphologyGraph = createGraphFromSerialized(normalizedGraph);

    if (hasCycle(graphologyGraph)) {
      return {
        valid: false,
        error: "Graph must be acyclic",
      };
    }
  } catch {
    return {
      valid: false,
      error: "Invalid graph payload",
    };
  }

  const hasTriggerNode = normalizedGraph.nodes.some(
    (node) => getNodeTypeFromSerializedNode(node) === "trigger"
  );

  if (!hasTriggerNode) {
    return {
      valid: false,
      error: "Workflow must contain at least one trigger node",
    };
  }

  if (!hasRootTrigger(graphData)) {
    return {
      valid: false,
      error: "Workflow must contain at least one root trigger node",
    };
  }

  const conditionBranchValidationError =
    validateConditionBranchEdges(graphData);
  if (conditionBranchValidationError) {
    return {
      valid: false,
      error: conditionBranchValidationError,
    };
  }

  return {
    valid: true,
    graph: normalizedGraph,
    nodes: graphData.nodes,
    edges: graphData.edges,
  };
}

export function getWorkflowGraphData(graph: SerializedWorkflowGraph): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  return toWorkflowGraphData(graph);
}
