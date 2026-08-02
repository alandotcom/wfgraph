import { Result, Schema } from "effect";
import { DirectedGraph } from "graphology";
import { formatSchemaFailure } from "#src/types/schema-message";
import { rejectUnknownKeys } from "#src/types/schema";
import {
  serializedWorkflowGraphSchema,
  workflowEdgeAttributesSchema,
  workflowNodeAttributesSchema,
} from "#src/graph/schemas";
import type {
  PersistedNodeData,
  SerializedWorkflowEdge,
  SerializedWorkflowGraph,
  SerializedWorkflowNode,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeType,
} from "#src/graph/types";

export const WORKFLOW_GRAPH_OPTIONS = {
  allowSelfLoops: false,
  multi: false,
  type: "directed",
} as const;

/**
 * The five ways this module reads a graph shape, bound once here.
 *
 * `rejectUnknownKeys` is what makes the closed schemas closed, so every decode
 * below has to carry it; binding the decoders at module scope is what keeps
 * that from being a thing each call site remembers. The `Result` variants
 * answer with a failure value rather than throwing, for the two callers that
 * ask whether a graph is valid instead of insisting it is.
 */
const decodeGraph = Schema.decodeUnknownSync(
  serializedWorkflowGraphSchema,
  rejectUnknownKeys
);
const readGraph = Schema.decodeUnknownResult(serializedWorkflowGraphSchema, {
  ...rejectUnknownKeys,
  errors: "all",
});
const decodeNodeAttributes = Schema.decodeUnknownSync(
  workflowNodeAttributesSchema,
  rejectUnknownKeys
);
const readNodeAttributes = Schema.decodeUnknownResult(
  workflowNodeAttributesSchema,
  rejectUnknownKeys
);
const decodeEdgeAttributes = Schema.decodeUnknownSync(
  workflowEdgeAttributesSchema,
  rejectUnknownKeys
);

function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return value === "lifecycle" || value === "action" || value === "add";
}

/**
 * Drop editor/run overlay keys that StructWithRest may have admitted from an
 * old row or an in-process React Flow export.
 */
function toPersistedNodeData(data: {
  label: string;
  description?: string;
  type: WorkflowNodeType;
  config?: unknown;
  enabled?: boolean;
  status?: unknown;
}): PersistedNodeData {
  const persisted: PersistedNodeData = {
    label: data.label,
    type: data.type,
  };
  if (data.description !== undefined) {
    persisted.description = data.description;
  }
  if (
    typeof data.config === "object" &&
    data.config !== null &&
    !Array.isArray(data.config)
  ) {
    persisted.config = { ...data.config };
  }
  if (data.enabled !== undefined) {
    persisted.enabled = data.enabled;
  }
  return persisted;
}

/** Node shape accepted at the encode boundary (editor may still carry status). */
export type WorkflowGraphNodeInput = {
  id: string;
  position: { x: number; y: number };
  data: {
    label: string;
    description?: string;
    type: WorkflowNodeType;
    config?: unknown;
    enabled?: boolean;
    status?: unknown;
  };
  type?: string;
  selected?: boolean;
  dragging?: boolean;
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
};

function readOptionalBoolean(
  record: { readonly [key: string]: unknown },
  key: string
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function parseNodeAttributes(attributes: unknown): WorkflowNode {
  const parsed = decodeNodeAttributes(attributes);

  return {
    id: parsed.id,
    type: parsed.type,
    position: parsed.position ?? { x: 0, y: 0 },
    data: toPersistedNodeData(parsed.data),
    selected: readOptionalBoolean(parsed, "selected"),
  };
}

function parseEdgeAttributes(attributes: unknown): WorkflowEdge {
  const parsed = decodeEdgeAttributes(attributes);
  return {
    id: parsed.id,
    source: parsed.source,
    target: parsed.target,
    sourceHandle: parsed.sourceHandle,
    targetHandle: parsed.targetHandle,
    data: parsed.data,
  };
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
  nodes: WorkflowGraphNodeInput[];
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
    graph.mergeNode(node.id, {
      ...node,
      data: toPersistedNodeData(node.data),
    });
  }

  for (const edge of input.edges) {
    graph.mergeEdgeWithKey(edge.id, edge.source, edge.target, edge);
  }

  return parseSerializedWorkflowGraph(graph.export());
}

export function parseSerializedWorkflowGraph(
  value: unknown
): SerializedWorkflowGraph {
  return decodeGraph(value);
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
  return Result.isSuccess(readGraph(value));
}

export function getNodeTypeFromSerializedNode(
  node: SerializedWorkflowNode
): WorkflowNodeType | undefined {
  const parsed = readNodeAttributes(node.attributes);
  if (Result.isFailure(parsed)) {
    return undefined;
  }

  const dataType = parsed.success.data.type;
  if (isWorkflowNodeType(dataType)) {
    return dataType;
  }

  return undefined;
}

export function getSerializedWorkflowGraphError(graph: unknown): string {
  const parsed = readGraph(graph);

  return Result.isSuccess(parsed)
    ? ""
    : formatSchemaFailure(parsed.failure.issue);
}
