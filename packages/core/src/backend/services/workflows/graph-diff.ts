/**
 * Compares serialized graphs through the canonical semantic projection, then
 * reports changes in stable order for rendering and persistence.
 */

import type {
  WorkflowEdgeChange,
  WorkflowFieldChange,
  WorkflowNodeChange,
} from "@wfgraph/shared/graph/publication-contracts";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@wfgraph/shared/types/json";
import type {
  SerializedWorkflowEdge,
  SerializedWorkflowGraph,
  SerializedWorkflowNode,
} from "@wfgraph/shared/graph/types";
import { groupBy, union } from "es-toolkit/array";
import { mapValues } from "es-toolkit/object";
import {
  normalizeSemanticValue,
  projectSemanticWorkflowEdge,
  projectSemanticWorkflowNodeFields,
  semanticValueKey,
} from "#src/backend/services/workflows/semantic-graph";

const MISSING = Symbol("missing");
type Missing = typeof MISSING;
type ComparableValue = JsonValue | Missing;

export type WorkflowGraphDiff = {
  hasChanges: boolean;
  nodeChanges: WorkflowNodeChange[];
  edgeChanges: WorkflowEdgeChange[];
};

/**
 * Orders two strings by UTF-16 code unit. The diff is persisted and compared
 * across machines, so this must stay code-unit order. Do not replace it with
 * `compareText` or `localeCompare`, whose result depends on the locale.
 */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparable(value: unknown): ComparableValue {
  const normalized = normalizeSemanticValue(value);
  return normalized === undefined ? MISSING : normalized;
}

function presentValue(value: ComparableValue): JsonValue {
  if (value === MISSING) {
    throw new Error("Expected a present JSON value");
  }
  return value;
}

function pathCompare(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const segment = compareStrings(left[index] ?? "", right[index] ?? "");
    if (segment !== 0) {
      return segment;
    }
  }
  return left.length - right.length;
}

function collectFieldChanges(
  before: unknown,
  after: unknown,
  path: string[],
  changes: WorkflowFieldChange[]
): void {
  const beforeValue = comparable(before);
  const afterValue = comparable(after);

  if (beforeValue === MISSING && afterValue === MISSING) {
    return;
  }
  if (
    beforeValue !== MISSING &&
    afterValue !== MISSING &&
    JSON.stringify(beforeValue) === JSON.stringify(afterValue)
  ) {
    return;
  }

  if (
    beforeValue !== MISSING &&
    afterValue !== MISSING &&
    ((isJsonObject(beforeValue) && isJsonObject(afterValue)) ||
      (Array.isArray(beforeValue) && Array.isArray(afterValue)))
  ) {
    collectObjectFieldChanges(beforeValue, afterValue, path, changes);
    return;
  }

  // Expanding an added or removed object gives callers useful nested config
  // paths. An empty object still has a value, so it is recorded at its own path.
  if (
    beforeValue === MISSING &&
    afterValue !== MISSING &&
    isContainer(afterValue)
  ) {
    collectObjectFieldChanges(MISSING, afterValue, path, changes);
    return;
  }
  if (
    beforeValue !== MISSING &&
    afterValue === MISSING &&
    isContainer(beforeValue)
  ) {
    collectObjectFieldChanges(beforeValue, MISSING, path, changes);
    return;
  }

  if (beforeValue === MISSING) {
    changes.push({ path, kind: "added", after: presentValue(afterValue) });
  } else if (afterValue === MISSING) {
    changes.push({ path, kind: "removed", before: beforeValue });
  } else {
    changes.push({
      path,
      kind: "modified",
      before: beforeValue,
      after: afterValue,
    });
  }
}

function isContainer(
  value: JsonValue | Missing
): value is JsonObject | JsonValue[] {
  return value !== MISSING && (isJsonObject(value) || Array.isArray(value));
}

function collectObjectFieldChanges(
  before: JsonObject | JsonValue[] | Missing,
  after: JsonObject | JsonValue[] | Missing,
  path: string[],
  changes: WorkflowFieldChange[]
): void {
  const beforeKeys =
    before === MISSING
      ? []
      : Array.isArray(before)
        ? before.map((_, index) => String(index))
        : Object.keys(before);
  const afterKeys =
    after === MISSING
      ? []
      : Array.isArray(after)
        ? after.map((_, index) => String(index))
        : Object.keys(after);
  const keys = union(beforeKeys, afterKeys).toSorted(compareStrings);

  if (keys.length === 0) {
    if (before === MISSING) {
      changes.push({ path, kind: "added", after: presentValue(after) });
    } else if (after === MISSING) {
      changes.push({ path, kind: "removed", before });
    }
    return;
  }

  for (const key of keys) {
    const beforeChild =
      before === MISSING
        ? undefined
        : Array.isArray(before)
          ? before[Number(key)]
          : before[key];
    const afterChild =
      after === MISSING
        ? undefined
        : Array.isArray(after)
          ? after[Number(key)]
          : after[key];
    collectFieldChanges(beforeChild, afterChild, [...path, key], changes);
  }
}

function nodeFields(
  before: SerializedWorkflowNode | undefined,
  after: SerializedWorkflowNode | undefined
): WorkflowFieldChange[] {
  const fields: WorkflowFieldChange[] = [];
  collectFieldChanges(
    before === undefined
      ? undefined
      : projectSemanticWorkflowNodeFields(before),
    after === undefined ? undefined : projectSemanticWorkflowNodeFields(after),
    [],
    fields
  );
  return fields
    .filter((field) => field.path.length > 0)
    .toSorted((left, right) => pathCompare(left.path, right.path));
}

function edgeSemanticKey(edge: SerializedWorkflowEdge): string {
  return semanticValueKey(projectSemanticWorkflowEdge(edge));
}

/**
 * Groups the edge ids by the semantic key of the edge they belong to. Each
 * group is sorted so that duplicate edges sharing one semantic key are matched
 * in the same order on every run. A semantic key is a JSON string, so the
 * result is only ever read by key and never iterated for its own order.
 */
function edgeIdsBySemanticKey(
  edges: SerializedWorkflowEdge[]
): Record<string, string[] | undefined> {
  return mapValues(groupBy(edges, edgeSemanticKey), (group) =>
    group.map((edge) => edge.key).toSorted(compareStrings)
  );
}

function unmatchedEdgeIds(
  baseIds: string[],
  draftIds: string[]
): {
  removed: string[];
  added: string[];
} {
  const draftIdSet = new Set(draftIds);
  const sharedIds = new Set(baseIds.filter((edgeId) => draftIdSet.has(edgeId)));
  const remainingBase = baseIds.filter((edgeId) => !sharedIds.has(edgeId));
  const remainingDraft = draftIds.filter((edgeId) => !sharedIds.has(edgeId));
  const semanticallyMatched = Math.min(
    remainingBase.length,
    remainingDraft.length
  );

  return {
    removed: remainingBase.slice(semanticallyMatched),
    added: remainingDraft.slice(semanticallyMatched),
  };
}

const EDGE_KIND_ORDER: Record<WorkflowEdgeChange["kind"], number> = {
  removed: 0,
  added: 1,
};

/** Returns a deterministic semantic diff suitable for the publication contract. */
export function diffWorkflowGraphs(
  baseGraph: SerializedWorkflowGraph,
  draftGraph: SerializedWorkflowGraph
): WorkflowGraphDiff {
  const baseNodes = new Map(baseGraph.nodes.map((node) => [node.key, node]));
  const draftNodes = new Map(draftGraph.nodes.map((node) => [node.key, node]));
  const nodeIds = union([...baseNodes.keys()], [...draftNodes.keys()]).toSorted(
    compareStrings
  );
  const nodeChanges: WorkflowNodeChange[] = [];

  for (const nodeId of nodeIds) {
    const before = baseNodes.get(nodeId);
    const after = draftNodes.get(nodeId);
    const kind =
      before === undefined
        ? "added"
        : after === undefined
          ? "removed"
          : "modified";
    const fields = nodeFields(before, after);

    if (kind !== "modified" || fields.length > 0) {
      nodeChanges.push({ nodeId, kind, fields });
    }
  }

  const baseEdges = edgeIdsBySemanticKey(baseGraph.edges);
  const draftEdges = edgeIdsBySemanticKey(draftGraph.edges);
  const semanticEdgeKeys = union(
    Object.keys(baseEdges),
    Object.keys(draftEdges)
  ).toSorted(compareStrings);
  const edgeChanges: WorkflowEdgeChange[] = [];

  for (const semanticKey of semanticEdgeKeys) {
    const { removed, added } = unmatchedEdgeIds(
      baseEdges[semanticKey] ?? [],
      draftEdges[semanticKey] ?? []
    );
    for (const edgeId of removed) {
      edgeChanges.push({ edgeId, kind: "removed" });
    }
    for (const edgeId of added) {
      edgeChanges.push({ edgeId, kind: "added" });
    }
  }

  edgeChanges.sort(
    (left, right) =>
      compareStrings(left.edgeId, right.edgeId) ||
      EDGE_KIND_ORDER[left.kind] - EDGE_KIND_ORDER[right.kind]
  );

  return {
    hasChanges: nodeChanges.length > 0 || edgeChanges.length > 0,
    nodeChanges,
    edgeChanges,
  };
}
