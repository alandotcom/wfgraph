/**
 * The Lifecycle Node's outlets, named where both sides can read them, and the
 * walk that says which of them a node sits behind.
 *
 * The editor draws edges from a handle carrying one of these ids and the save
 * refuses an edge from the entry node that names neither, so each string has one
 * owner. A node behind Canceled reads a different payload from one behind
 * Started: a run enters that outlet carrying what the canceling Event sent.
 */

import { descendantsOf } from "#src/graph/descendants";
import type { WorkflowEdge } from "#src/graph/types";

export const LIFECYCLE_STARTED_HANDLE = "started";
export const LIFECYCLE_CANCELED_HANDLE = "canceled";

/** Which outlet of the entry node a run came through to reach a given node. */
export type LifecycleOutlet =
  | typeof LIFECYCLE_STARTED_HANDLE
  | typeof LIFECYCLE_CANCELED_HANDLE;

/** Whether an edge's handle names an outlet, which the save rules hold it to. */
export function isLifecycleOutlet(
  sourceHandle: string | null | undefined
): sourceHandle is LifecycleOutlet {
  return (
    sourceHandle === LIFECYCLE_STARTED_HANDLE ||
    sourceHandle === LIFECYCLE_CANCELED_HANDLE
  );
}

/**
 * Every node behind one outlet: the nodes the edges that outlet opens land on,
 * and everything downstream of those.
 *
 * The engine reads it to know which side of the lifecycle a node sits on.
 */
export function nodesBehindOutlet(input: {
  entryNodeIds: ReadonlySet<string>;
  outlet: LifecycleOutlet;
  edges: readonly WorkflowEdge[];
}): Set<string> {
  const { entryNodeIds, outlet, edges } = input;
  const behind = new Set<string>();

  for (const edge of edges) {
    if (entryNodeIds.has(edge.source) && edge.sourceHandle === outlet) {
      behind.add(edge.target);
    }
  }

  for (const nodeId of descendantsOf({ startIds: behind, edges })) {
    behind.add(nodeId);
  }

  return behind;
}

/**
 * The outlets a run can have left the entry node through and still arrive at this
 * node.
 *
 * Both outlets answer for a node each of them reaches, and neither answers for a
 * node the entry node cannot reach at all. What callers read off the members is
 * which Events could have put a run here, which decides the fields a picker
 * offers and what a rule about the arriving Event selects between.
 */
export function entryOutletsReaching(input: {
  entryNodeId: string;
  targetNodeId: string;
  edges: readonly WorkflowEdge[];
}): Set<LifecycleOutlet> {
  const { entryNodeId, targetNodeId, edges } = input;
  const entryNodeIds = new Set([entryNodeId]);
  const outlets = new Set<LifecycleOutlet>();

  for (const outlet of [
    LIFECYCLE_STARTED_HANDLE,
    LIFECYCLE_CANCELED_HANDLE,
  ] as const) {
    if (nodesBehindOutlet({ entryNodeIds, outlet, edges }).has(targetNodeId)) {
      outlets.add(outlet);
    }
  }

  return outlets;
}
