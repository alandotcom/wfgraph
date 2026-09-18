/**
 * Sorts the changes of a workflow comparison into Organization and Behavior.
 * A Group frame and every field on it, and a step's Group membership, are
 * Organization, because a run takes the same path whatever the Groups are.
 * Every other node field, every added or removed step, and every stored edge
 * is Behavior. A modified node that records no field is counted as Behavior.
 */

import { compact } from "es-toolkit/array";
import type {
  WorkflowComparisonPayload,
  WorkflowNodeChange,
} from "#src/graph/publication-contracts";

export type WorkflowChangeCategory = "organization" | "behavior";

/** Which categories one node change touches. A node can touch both. */
export type NodeChangeCategories = {
  organization: boolean;
  behavior: boolean;
};

/**
 * Whether a node is a Group frame in every graph that holds it. `before` and
 * `after` are the node's `data.type` in the published and draft graphs, or
 * undefined for a graph that does not hold it.
 */
export function isGroupFrameChange(input: {
  before: string | undefined;
  after: string | undefined;
}): boolean {
  const types = compact([input.before, input.after]);
  return types.length > 0 && types.every((type) => type === "group");
}

/** Whether a field change at `path` is the node's Group membership. */
export function isGroupMembershipPath(path: readonly string[]): boolean {
  return path.length === 1 && path[0] === "parentId";
}

/**
 * The category of one field change at `path` on a node. `groupFrame` says the
 * node is a Group frame in every graph that holds it.
 */
export function fieldChangeCategory(input: {
  path: readonly string[];
  groupFrame: boolean;
}): WorkflowChangeCategory {
  if (input.groupFrame) {
    return "organization";
  }
  return isGroupMembershipPath(input.path) ? "organization" : "behavior";
}

/**
 * The categories one node change touches. An added or removed Group frame is
 * Organization. An added or removed step is Behavior, and the Group it sits in
 * is part of that step's change.
 */
export function nodeChangeCategories(input: {
  change: WorkflowNodeChange;
  groupFrame: boolean;
}): NodeChangeCategories {
  const { change, groupFrame } = input;
  if (groupFrame) {
    return { organization: true, behavior: false };
  }
  if (change.kind !== "modified" || change.fields.length === 0) {
    return { organization: false, behavior: true };
  }
  const categories = new Set(
    change.fields.map((field) =>
      fieldChangeCategory({ path: field.path, groupFrame })
    )
  );
  return {
    organization: categories.has("organization"),
    behavior: categories.has("behavior"),
  };
}

/** Every node change of a comparison classified, and what the whole touches. */
export type WorkflowComparisonCategories = {
  /** Each changed node's categories, by node id. */
  nodes: ReadonlyMap<string, NodeChangeCategories>;
  /** The ids of changed nodes that are Group frames on every side holding them. */
  groupFrameIds: ReadonlySet<string>;
  organization: boolean;
  behavior: boolean;
};

type ComparisonGraphs = Pick<
  WorkflowComparisonPayload,
  "baseGraph" | "draftGraph" | "nodeChanges" | "edgeChanges"
>;

const classificationCache = new WeakMap<
  ComparisonGraphs,
  WorkflowComparisonCategories
>();

function nodeTypes(
  graph: WorkflowComparisonPayload["baseGraph"]
): Map<string, string> {
  return new Map(
    graph.nodes.map((node) => [node.key, node.attributes.data.type])
  );
}

/**
 * Classifies every change of `payload`. Any edge change makes the comparison
 * touch Behavior. The result is computed once per payload object.
 */
export function classifyWorkflowComparison(
  payload: ComparisonGraphs
): WorkflowComparisonCategories {
  const cached = classificationCache.get(payload);
  if (cached) {
    return cached;
  }
  const baseTypes = nodeTypes(payload.baseGraph);
  const draftTypes = nodeTypes(payload.draftGraph);
  const nodes = new Map<string, NodeChangeCategories>();
  const groupFrameIds = new Set<string>();
  for (const change of payload.nodeChanges) {
    const groupFrame = isGroupFrameChange({
      before: baseTypes.get(change.nodeId),
      after: draftTypes.get(change.nodeId),
    });
    if (groupFrame) {
      groupFrameIds.add(change.nodeId);
    }
    nodes.set(change.nodeId, nodeChangeCategories({ change, groupFrame }));
  }
  const categories = [...nodes.values()];
  const result: WorkflowComparisonCategories = {
    nodes,
    groupFrameIds,
    organization: categories.some((item) => item.organization),
    behavior:
      payload.edgeChanges.length > 0 ||
      categories.some((item) => item.behavior),
  };
  classificationCache.set(payload, result);
  return result;
}
