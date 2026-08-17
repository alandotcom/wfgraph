/**
 * AND-join rules for a node with more than one incoming edge.
 *
 * A join is illegal when it sits behind two exclusive outlets of one node
 * (Lifecycle, Condition, Event Split), or when a Wait sits on an arm. Saving
 * and the canvas share this; the engine's readiness gate is separate.
 */

import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "#src/conditions/condition-branch";
import { isWaitNode } from "#src/graph/node-config";
import type { WorkflowNode } from "#src/graph/types";
import { upstreamNodeIds } from "#src/graph/upstream-nodes";
import { isEventSplitNode } from "#src/lifecycle/event-split";

/** The fields join policy reads off an edge. Editor and persisted edges both fit. */
export type JoinGraphEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null;
};

function nodeLabel(node: WorkflowNode | undefined, fallbackId: string): string {
  return node?.data.label?.trim() || fallbackId;
}

function isExclusiveSplit(node: WorkflowNode): boolean {
  return (
    node.data.type === "lifecycle" ||
    isConditionActionNode(node) ||
    isEventSplitNode(node)
  );
}

function exclusiveHandleKey(edge: JoinGraphEdge): string {
  const branch = normalizeConditionBranch(edge.sourceHandle);
  if (branch) {
    return branch;
  }
  return typeof edge.sourceHandle === "string" && edge.sourceHandle.length > 0
    ? edge.sourceHandle
    : "";
}

/**
 * Nodes on the parallel arms into a join: upstream of the join, minus ancestors
 * shared by every direct predecessor (the graph above the fan-out).
 */
function nodesOnJoinArms(input: {
  joinNodeId: string;
  predecessorIds: readonly string[];
  edges: readonly JoinGraphEdge[];
}): Set<string> {
  const { joinNodeId, predecessorIds, edges } = input;
  if (predecessorIds.length === 0) {
    return new Set();
  }

  let commonAncestors: Set<string> | null = null;
  for (const predecessorId of predecessorIds) {
    const upstream = upstreamNodeIds(predecessorId, edges);
    if (!commonAncestors) {
      commonAncestors = upstream;
      continue;
    }
    for (const id of commonAncestors) {
      if (!upstream.has(id)) {
        commonAncestors.delete(id);
      }
    }
  }

  const onArms = upstreamNodeIds(joinNodeId, edges);
  for (const id of commonAncestors ?? []) {
    onArms.delete(id);
  }
  return onArms;
}

function refusalForJoin(input: {
  joinNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly JoinGraphEdge[];
}): string | null {
  const { joinNodeId, nodes, edges } = input;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const joinLabel = nodeLabel(nodeById.get(joinNodeId), joinNodeId);
  const predecessorIds = edges
    .filter((edge) => edge.target === joinNodeId)
    .map((edge) => edge.source);
  const upstream = upstreamNodeIds(joinNodeId, edges);

  const handlesBySplit = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.target !== joinNodeId && !upstream.has(edge.target)) {
      continue;
    }
    const source = nodeById.get(edge.source);
    if (!source || !isExclusiveSplit(source)) {
      continue;
    }
    const handles = handlesBySplit.get(source.id) ?? new Set<string>();
    handles.add(exclusiveHandleKey(edge));
    handlesBySplit.set(source.id, handles);
  }

  for (const [sourceId, handles] of handlesBySplit) {
    if (handles.size <= 1) {
      continue;
    }
    const source = nodeById.get(sourceId);
    if (source?.data.type === "lifecycle") {
      return `Node "${joinLabel}" cannot join the Started and Canceled branches`;
    }
    return `Node "${joinLabel}" cannot join mutually exclusive branches from "${nodeLabel(source, sourceId)}"`;
  }

  for (const armNodeId of nodesOnJoinArms({
    joinNodeId,
    predecessorIds,
    edges,
  })) {
    const armNode = nodeById.get(armNodeId);
    if (armNode && isWaitNode(armNode)) {
      return `Node "${joinLabel}" cannot join branches that include a Wait (found "${nodeLabel(armNode, armNodeId)}")`;
    }
  }

  return null;
}

/**
 * Why any AND-join in the graph is refused, or null when every multi-incoming
 * node is an allowed join.
 */
export function andJoinRefusalReason(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly JoinGraphEdge[];
}): string | null {
  const incomingCount = new Map<string, number>();
  for (const edge of input.edges) {
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
  }

  for (const [targetId, count] of incomingCount) {
    if (count <= 1) {
      continue;
    }
    const reason = refusalForJoin({
      joinNodeId: targetId,
      nodes: input.nodes,
      edges: input.edges,
    });
    if (reason) {
      return reason;
    }
  }
  return null;
}
