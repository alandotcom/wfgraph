/**
 * Defines the canonical workflow meaning used by publication features.
 * Editor geometry, graph metadata, array order, and generated edge ids stay
 * outside this projection.
 */

import { sortBy } from "es-toolkit/array";
import { isEmptyObject } from "es-toolkit/predicate";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@wfgraph/shared/types/json";
import { persistedNodeEnabled } from "@wfgraph/shared/graph/node-enabled";
import type {
  SerializedWorkflowEdge,
  SerializedWorkflowGraph,
  SerializedWorkflowNode,
} from "@wfgraph/shared/graph/types";

/** Converts an in-process value to stable JSON with recursively sorted keys. */
export function normalizeSemanticValue(
  value: unknown,
  inArray = false,
  seen = new Set<object>()
): JsonValue | undefined {
  if (value === undefined) {
    return inArray ? null : undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return null;
  }
  if (typeof value === "function") {
    return inArray ? null : undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "object") {
    return inArray ? null : undefined;
  }
  if (seen.has(value)) {
    return null;
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.map((item) =>
      normalizeSemanticValue(item, true, seen)
    );
    seen.delete(value);
    return normalized.map((item) => item ?? null);
  }

  // Keys are sorted so two objects written in different key orders normalize
  // alike. A key is an identifier, so code-unit order is enough.
  const object: JsonObject = {};
  for (const [key, rawItem] of sortBy(Object.entries(value), [
    ([entryKey]) => entryKey,
  ])) {
    const item = normalizeSemanticValue(rawItem, false, seen);
    if (item !== undefined) {
      object[key] = item;
    }
  }
  seen.delete(value);
  return object;
}

function normalizedObject(value: Record<string, unknown>): JsonObject {
  const normalized = normalizeSemanticValue(value);
  if (!isJsonObject(normalized)) {
    throw new Error("Expected semantic projection to produce an object");
  }
  return normalized;
}

/** Projects the fields whose change alters one node's published meaning. */
export function projectSemanticWorkflowNodeFields(
  node: SerializedWorkflowNode
): JsonObject {
  const data = node.attributes.data;
  return normalizedObject({
    type: node.attributes.type,
    parentId: node.attributes.parentId,
    data: {
      type: data.type,
      label: data.label,
      description: data.description,
      enabled: persistedNodeEnabled(data.enabled),
      config: data.config,
    },
  });
}

/** Projects an edge while leaving its editor-generated id out of its identity. */
export function projectSemanticWorkflowEdge(
  edge: SerializedWorkflowEdge
): JsonObject {
  const data = normalizeSemanticValue(edge.attributes.data);
  const normalizedData = isEmptyObject(data) ? undefined : data;

  return normalizedObject({
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.attributes.sourceHandle ?? undefined,
    targetHandle: edge.attributes.targetHandle ?? undefined,
    data: normalizedData,
  });
}

export function semanticValueKey(value: JsonValue): string {
  return JSON.stringify(value);
}

/** Returns the canonical graph projection used for equality and hashing. */
export function projectSemanticWorkflowGraph(
  graph: SerializedWorkflowGraph
): JsonObject {
  // Nodes and edges are sorted on their own JSON key so two graphs with the
  // same meaning hash alike whatever order the editor held them in. The key is
  // generated JSON, so code-unit order is enough.
  const nodes = sortBy(
    graph.nodes.map((node) =>
      normalizedObject({
        id: node.key,
        ...projectSemanticWorkflowNodeFields(node),
      })
    ),
    [(node) => semanticValueKey(node)]
  );
  const edges = sortBy(graph.edges.map(projectSemanticWorkflowEdge), [
    (edge) => semanticValueKey(edge),
  ]);

  return normalizedObject({ nodes, edges });
}

export function semanticWorkflowGraphsEqual(
  left: SerializedWorkflowGraph,
  right: SerializedWorkflowGraph
): boolean {
  return (
    semanticValueKey(projectSemanticWorkflowGraph(left)) ===
    semanticValueKey(projectSemanticWorkflowGraph(right))
  );
}
