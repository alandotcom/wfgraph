import { DirectedGraph } from "graphology";
import { z } from "zod";
import {
  serializedWorkflowGraphSchema,
  workflowEdgeAttributesSchema,
  workflowNodeAttributesSchema,
} from "@/workflow/schemas";
import type {
  SerializedWorkflowEdge,
  SerializedWorkflowGraph,
  SerializedWorkflowNode,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "@/workflow/types";

export const WORKFLOW_GRAPH_OPTIONS = {
  allowSelfLoops: false,
  multi: false,
  type: "directed",
} as const;

function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return value === "trigger" || value === "action" || value === "add";
}

function parseNodeAttributes(attributes: unknown): WorkflowNode {
  const parsed = workflowNodeAttributesSchema.parse(attributes);

  return {
    ...parsed,
    position: parsed.position ?? { x: 0, y: 0 },
  } as WorkflowNode;
}

function parseEdgeAttributes(attributes: unknown): WorkflowEdge {
  return workflowEdgeAttributesSchema.parse(attributes) as WorkflowEdge;
}

function toNodeFromSerialized(
  serializedNode: SerializedWorkflowNode
): WorkflowNode {
  const parsedNode = parseNodeAttributes(serializedNode.attributes);

  if (serializedNode.key !== parsedNode.id) {
    throw new Error(
      `Node key '${serializedNode.key}' must match node attribute id '${parsedNode.id}'`
    );
  }

  return parsedNode;
}

function toEdgeFromSerialized(
  serializedEdge: SerializedWorkflowEdge
): WorkflowEdge {
  const parsedEdge = parseEdgeAttributes(serializedEdge.attributes);

  if (serializedEdge.key !== parsedEdge.id) {
    throw new Error(
      `Edge key '${serializedEdge.key}' must match edge attribute id '${parsedEdge.id}'`
    );
  }

  if (
    serializedEdge.source !== parsedEdge.source ||
    serializedEdge.target !== parsedEdge.target
  ) {
    throw new Error(
      `Edge '${serializedEdge.key}' source/target must match edge attributes`
    );
  }

  return parsedEdge;
}

export function createSerializedWorkflowGraph(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  attributes?: Record<string, unknown>;
}): SerializedWorkflowGraph {
  const graph = new DirectedGraph({
    allowSelfLoops: WORKFLOW_GRAPH_OPTIONS.allowSelfLoops,
    multi: WORKFLOW_GRAPH_OPTIONS.multi,
  });

  if (input.attributes) {
    graph.replaceAttributes(input.attributes);
  }

  for (const node of input.nodes) {
    graph.mergeNode(node.id, node);
  }

  for (const edge of input.edges) {
    graph.mergeEdgeWithKey(edge.id, edge.source, edge.target, edge);
  }

  return parseSerializedWorkflowGraph(graph.export());
}

export function parseSerializedWorkflowGraph(
  value: unknown
): SerializedWorkflowGraph {
  return serializedWorkflowGraphSchema.parse(value);
}

export function createGraphFromSerialized(
  serializedGraph: SerializedWorkflowGraph
): DirectedGraph {
  const graph = new DirectedGraph({
    allowSelfLoops: WORKFLOW_GRAPH_OPTIONS.allowSelfLoops,
    multi: WORKFLOW_GRAPH_OPTIONS.multi,
  });

  graph.import(parseSerializedWorkflowGraph(serializedGraph));

  return graph;
}

export function toWorkflowGraphData(serializedGraph: SerializedWorkflowGraph): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
} {
  const parsedGraph = parseSerializedWorkflowGraph(serializedGraph);
  const nodes = parsedGraph.nodes.map(toNodeFromSerialized);
  const edges = parsedGraph.edges.map(toEdgeFromSerialized);

  return {
    nodes,
    edges,
  };
}

export function isSerializedWorkflowGraph(
  value: unknown
): value is SerializedWorkflowGraph {
  return serializedWorkflowGraphSchema.safeParse(value).success;
}

export function getNodeTypeFromSerializedNode(
  node: SerializedWorkflowNode
): WorkflowNodeType | undefined {
  const parsed = workflowNodeAttributesSchema.safeParse(node.attributes);
  if (!parsed.success) {
    return;
  }

  const dataType = parsed.data.data.type;
  if (isWorkflowNodeType(dataType)) {
    return dataType;
  }

  return;
}

export function getSerializedWorkflowGraphError(graph: unknown): string {
  const parsed = serializedWorkflowGraphSchema.safeParse(graph);
  if (parsed.success) {
    return "";
  }

  const firstIssue = parsed.error.issues[0];
  if (!firstIssue) {
    return "Invalid graph payload";
  }

  const path = firstIssue.path.join(".");
  if (!path) {
    return firstIssue.message;
  }

  return `${path}: ${firstIssue.message}`;
}

export function isGraphValidationError(error: unknown): boolean {
  return error instanceof z.ZodError || error instanceof Error;
}
