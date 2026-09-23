/**
 * AND-join rules for a multi-incoming node. Illegal: two exclusive outlets of
 * one split, a Wait on an arm, or an arm that never leaves a Lifecycle Node.
 * Save and the canvas refuse through this, Group publication reads the arms
 * `andJoinArms` finds, and the engine's readiness gate is separate. A disabled
 * step on an arm is shown rather than refused; the canvas mutes the join.
 */

import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "#src/conditions/condition-branch";
import { isWaitNode } from "#src/graph/node-config";
import type { WorkflowNode } from "#src/graph/types";
import { upstreamNodeIdsOver } from "#src/graph/upstream-nodes";
import {
  eventSplitOutletEvent,
  isEventSplitNode,
} from "#src/lifecycle/event-split";

/** The fields join policy reads off an edge. Editor and persisted edges both fit. */
export type JoinGraphEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null | undefined;
};

/** `upstreamNodeIds` over the edge list one join analysis reads. */
type UpstreamOf = (nodeId: string) => Set<string>;

function nodeLabel(node: WorkflowNode | undefined, fallbackId: string): string {
  return node?.data.label?.trim() || fallbackId;
}

/**
 * Whether a node sends a run down only some of its outlets: the Lifecycle Node,
 * a Condition, or an Event Split.
 */
function isExclusiveSplit(node: WorkflowNode): boolean {
  return (
    node.data.type === "lifecycle" ||
    isConditionActionNode(node) ||
    isEventSplitNode(node)
  );
}

function exclusiveHandleKey(edge: JoinGraphEdge): string {
  const outlet =
    normalizeConditionBranch(edge.sourceHandle) ??
    eventSplitOutletEvent(edge.sourceHandle);
  if (outlet) {
    return outlet;
  }
  return typeof edge.sourceHandle === "string" && edge.sourceHandle.length > 0
    ? edge.sourceHandle
    : "";
}

/**
 * Nodes on the parallel arms into a join: upstream of the join, minus the nodes
 * every direct predecessor has run through by the time it finishes. Each
 * predecessor counts as run through by itself, so a fan-out node with its own
 * edge into the join sits above the fan-out and on no arm.
 */
function nodesOnJoinArms(input: {
  joinNodeId: string;
  predecessorIds: readonly string[];
  upstreamOf: UpstreamOf;
}): Set<string> {
  const { joinNodeId, predecessorIds, upstreamOf } = input;
  const reachedBy = predecessorIds.map((predecessorId) =>
    upstreamOf(predecessorId).add(predecessorId)
  );
  const [first, ...rest] = reachedBy;
  const onArms = upstreamOf(joinNodeId);
  if (!first) {
    return onArms;
  }
  for (const id of first) {
    if (rest.every((reached) => reached.has(id))) {
      onArms.delete(id);
    }
  }
  return onArms;
}

function reachesLifecycleNode(input: {
  nodeId: string;
  nodeById: ReadonlyMap<string, WorkflowNode>;
  upstreamOf: UpstreamOf;
}): boolean {
  if (input.nodeById.get(input.nodeId)?.data.type === "lifecycle") {
    return true;
  }
  for (const ancestorId of input.upstreamOf(input.nodeId)) {
    if (input.nodeById.get(ancestorId)?.data.type === "lifecycle") {
      return true;
    }
  }
  return false;
}

function refusalForJoin(input: {
  join: AndJoin;
  nodeById: ReadonlyMap<string, WorkflowNode>;
  edges: readonly JoinGraphEdge[];
  upstreamOf: UpstreamOf;
}): string | null {
  const { join, nodeById, edges, upstreamOf } = input;
  const { joinNodeId, predecessorIds } = join;
  const joinLabel = nodeLabel(nodeById.get(joinNodeId), joinNodeId);
  const upstream = upstreamOf(joinNodeId);

  for (const predecessorId of predecessorIds) {
    if (
      !reachesLifecycleNode({
        nodeId: predecessorId,
        nodeById,
        upstreamOf,
      })
    ) {
      return `Node "${joinLabel}" cannot join an unreachable branch (found "${nodeLabel(nodeById.get(predecessorId), predecessorId)}")`;
    }
  }

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

  for (const armNodeId of join.armNodeIds) {
    const armNode = nodeById.get(armNodeId);
    if (armNode && isWaitNode(armNode)) {
      return `Node "${joinLabel}" cannot join branches that include a Wait (found "${nodeLabel(armNode, armNodeId)}")`;
    }
  }

  return null;
}

/**
 * One AND-join. `predecessorIds` holds the source of each incoming edge, so a
 * split with two outlets into the join is named twice. The join node itself and
 * the graph above the fan-out are not in `armNodeIds`.
 */
export type AndJoin = {
  joinNodeId: string;
  predecessorIds: string[];
  armNodeIds: Set<string>;
};

/** Every node with more than one incoming edge, in node order, as an `AndJoin`. */
export function andJoinArms(input: {
  nodes: readonly { id: string }[];
  edges: readonly JoinGraphEdge[];
}): AndJoin[] {
  return joinsOver({ ...input, upstreamOf: upstreamNodeIdsOver(input.edges) });
}

function joinsOver(input: {
  nodes: readonly { id: string }[];
  edges: readonly JoinGraphEdge[];
  upstreamOf: UpstreamOf;
}): AndJoin[] {
  // A Map, because node ids are chosen by the builder.
  const incomingByTarget = Map.groupBy(input.edges, (edge) => edge.target);
  return input.nodes.flatMap((node) => {
    const predecessorIds = (incomingByTarget.get(node.id) ?? []).map(
      (edge) => edge.source
    );
    if (predecessorIds.length <= 1) {
      return [];
    }
    return [
      {
        joinNodeId: node.id,
        predecessorIds,
        armNodeIds: nodesOnJoinArms({
          joinNodeId: node.id,
          predecessorIds,
          upstreamOf: input.upstreamOf,
        }),
      },
    ];
  });
}

/**
 * Why the first refused AND-join in node order is refused, or null when every
 * multi-incoming node is an allowed join.
 */
export function andJoinRefusalReason(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly JoinGraphEdge[];
}): string | null {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const upstreamOf = upstreamNodeIdsOver(input.edges);
  for (const join of joinsOver({ ...input, upstreamOf })) {
    const reason = refusalForJoin({
      join,
      nodeById,
      edges: input.edges,
      upstreamOf,
    });
    if (reason) {
      return reason;
    }
  }
  return null;
}
