/**
 * AND-join rules for a node with more than one incoming edge.
 *
 * Fan-out already runs siblings side by side; these rules are what lets those
 * siblings feed one next step. A join runs only after every predecessor has
 * released it (engine), and saving / the canvas refuse the shapes that would
 * hang or cross the Canceled branch.
 */

import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "#src/conditions/condition-branch";
import { isWaitNode } from "#src/graph/node-config";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { upstreamNodeIds } from "#src/graph/upstream-nodes";
import { isEventSplitNode } from "#src/lifecycle/event-split";
import {
  entryOutletsReaching,
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "#src/lifecycle/lifecycle-outlets";

function nodeLabel(node: WorkflowNode | undefined, fallbackId: string): string {
  return node?.data.label?.trim() || fallbackId;
}

function incomingEdgesByTarget(
  edges: readonly WorkflowEdge[]
): Map<string, WorkflowEdge[]> {
  const byTarget = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    const list = byTarget.get(edge.target);
    if (list) {
      list.push(edge);
    } else {
      byTarget.set(edge.target, [edge]);
    }
  }
  return byTarget;
}

function targetsReachableFrom(
  startIds: readonly string[],
  edges: readonly WorkflowEdge[]
): Set<string> {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = targetsBySource.get(edge.source);
    if (targets) {
      targets.push(edge.target);
    } else {
      targetsBySource.set(edge.source, [edge.target]);
    }
  }

  const reached = new Set<string>();
  const pending = [...startIds];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || reached.has(nodeId)) {
      continue;
    }
    reached.add(nodeId);
    pending.push(...(targetsBySource.get(nodeId) ?? []));
  }
  return reached;
}

/**
 * Nodes on the parallel arms into a join: upstream of the join, minus ancestors
 * shared by every direct predecessor (the graph above the fan-out).
 */
function nodesOnJoinArms(input: {
  joinNodeId: string;
  predecessorIds: readonly string[];
  edges: readonly WorkflowEdge[];
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
    for (const id of [...commonAncestors]) {
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

function exclusiveHandleKey(edge: WorkflowEdge): string {
  const branch = normalizeConditionBranch(edge.sourceHandle);
  if (branch) {
    return branch;
  }
  return typeof edge.sourceHandle === "string" && edge.sourceHandle.length > 0
    ? edge.sourceHandle
    : "";
}

/**
 * Why this multi-incoming node is refused, or null when the AND-join is allowed.
 */
export function andJoinNodeRefusalReason(input: {
  joinNodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): string | null {
  const { joinNodeId, nodes, edges } = input;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const joinNode = nodeById.get(joinNodeId);
  const joinLabel = nodeLabel(joinNode, joinNodeId);

  const incoming = edges.filter((edge) => edge.target === joinNodeId);
  if (incoming.length <= 1) {
    return null;
  }

  const predecessorIds = incoming.map((edge) => edge.source);

  for (const node of nodes) {
    if (node.data.type !== "lifecycle") {
      continue;
    }
    const outlets = entryOutletsReaching({
      entryNodeId: node.id,
      targetNodeId: joinNodeId,
      edges,
    });
    if (
      outlets.has(LIFECYCLE_STARTED_HANDLE) &&
      outlets.has(LIFECYCLE_CANCELED_HANDLE)
    ) {
      return `Node "${joinLabel}" cannot join the Started and Canceled branches`;
    }
  }

  const armNodes = nodesOnJoinArms({
    joinNodeId,
    predecessorIds,
    edges,
  });
  for (const armNodeId of armNodes) {
    const armNode = nodeById.get(armNodeId);
    if (armNode && isWaitNode(armNode)) {
      return `Node "${joinLabel}" cannot join branches that include a Wait (found "${nodeLabel(armNode, armNodeId)}")`;
    }
  }

  for (const node of nodes) {
    if (!isConditionActionNode(node) && !isEventSplitNode(node)) {
      continue;
    }

    const outgoing = edges.filter((edge) => edge.source === node.id);
    const predsReachedByHandle = new Map<string, Set<string>>();

    for (const edge of outgoing) {
      const handle = exclusiveHandleKey(edge);
      const reached = targetsReachableFrom([edge.target], edges);
      reached.add(edge.target);
      const bucket = predsReachedByHandle.get(handle) ?? new Set<string>();
      for (const predecessorId of predecessorIds) {
        if (reached.has(predecessorId)) {
          bucket.add(predecessorId);
        }
      }
      if (bucket.size > 0) {
        predsReachedByHandle.set(handle, bucket);
      }
    }

    if (predsReachedByHandle.size <= 1) {
      continue;
    }

    const handleReachingAll = [...predsReachedByHandle.values()].some((preds) =>
      predecessorIds.every((id) => preds.has(id))
    );
    if (!handleReachingAll) {
      return `Node "${joinLabel}" cannot join mutually exclusive branches from "${nodeLabel(node, node.id)}"`;
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
  edges: readonly WorkflowEdge[];
}): string | null {
  const byTarget = incomingEdgesByTarget(input.edges);
  for (const [targetId, incoming] of byTarget) {
    if (incoming.length <= 1) {
      continue;
    }
    const reason = andJoinNodeRefusalReason({
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
