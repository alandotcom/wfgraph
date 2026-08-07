import { hasCycle } from "graphology-dag";
import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "@wfgraph/shared/conditions/condition-branch";
import { isLifecycleOutlet } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import {
  createGraphFromSerialized,
  getNodeTypeFromSerializedNode,
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

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function hasRootLifecycleNode(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): boolean {
  const incoming = new Set(input.edges.map((edge) => edge.target));
  return input.nodes.some(
    (node) => node.data.type === "lifecycle" && !incoming.has(node.id)
  );
}

/** What a refusal calls a node: the builder's own label, or the id they never set. */
export function getNodeLabel(node: WorkflowNode): string {
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

/**
 * Every edge leaving the entry node names the outlet it leaves from.
 *
 * The Lifecycle Node has two outlets, so an edge that names neither would bind
 * by whatever order React Flow happened to render the handles in, and the engine
 * follows only an edge naming the outlet the run took.
 */
function validateLifecycleOutletEdges(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): string | null {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));

  for (const edge of input.edges) {
    const sourceNode = nodeById.get(edge.source);
    if (sourceNode?.data.type !== "lifecycle") {
      continue;
    }

    if (!isLifecycleOutlet(edge.sourceHandle)) {
      return `Edge "${edge.id}" leaves the Lifecycle Node without naming an outlet. Redraw it from the "Started" or "Canceled" handle.`;
    }
  }

  return null;
}

/**
 * At most one incoming edge per node.
 *
 * This is also what keeps the Canceled branch terminal: a node the Started
 * branch reaches already has an incoming edge, so an edge from the Canceled
 * branch back into it is a second one.
 */
function validateSingleIncomingEdgePerNode(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): string | null {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const incomingEdgeByTarget = new Map<string, WorkflowEdge>();

  for (const edge of input.edges) {
    const existingIncomingEdge = incomingEdgeByTarget.get(edge.target);
    if (!existingIncomingEdge) {
      incomingEdgeByTarget.set(edge.target, edge);
      continue;
    }

    const targetNode = nodeById.get(edge.target);
    const targetLabel = targetNode ? getNodeLabel(targetNode) : edge.target;
    return `Node "${targetLabel}" cannot have multiple incoming edges (found "${existingIncomingEdge.id}" and "${edge.id}")`;
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

  const hasLifecycleNode = normalizedGraph.nodes.some(
    (node) => getNodeTypeFromSerializedNode(node) === "lifecycle"
  );

  if (!hasLifecycleNode) {
    return {
      valid: false,
      error: "Workflow must contain at least one Lifecycle Node",
    };
  }

  if (!hasRootLifecycleNode(graphData)) {
    return {
      valid: false,
      error: "Workflow must contain at least one root Lifecycle Node",
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

  const lifecycleOutletValidationError =
    validateLifecycleOutletEdges(graphData);
  if (lifecycleOutletValidationError) {
    return {
      valid: false,
      error: lifecycleOutletValidationError,
    };
  }

  const incomingEdgeValidationError =
    validateSingleIncomingEdgePerNode(graphData);
  if (incomingEdgeValidationError) {
    return {
      valid: false,
      error: incomingEdgeValidationError,
    };
  }

  return {
    valid: true,
    graph: normalizedGraph,
    nodes: graphData.nodes,
    edges: graphData.edges,
  };
}
