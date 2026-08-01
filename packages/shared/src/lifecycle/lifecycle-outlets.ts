/**
 * The Lifecycle Node's outlets, named where both sides can read them, and the
 * walk that says which of them a node sits behind.
 *
 * The editor draws edges from a handle carrying one of these ids and the save
 * refuses an edge from the entry node that names neither, so each string has one
 * owner. A node behind Canceled reads a different payload from one behind
 * Started: a run enters that outlet carrying what the canceling Event sent.
 */

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
 * Every node behind one outlet: the edges that outlet opens, and everything
 * downstream of them.
 *
 * The engine reads it to know which side of the lifecycle a node sits on. A
 * node already seen is not walked again, so a cycle terminates.
 */
export function nodesBehindOutlet(input: {
  entryNodeIds: ReadonlySet<string>;
  outlet: LifecycleOutlet;
  edges: readonly WorkflowEdge[];
}): Set<string> {
  const { entryNodeIds, outlet, edges } = input;
  const targetsBySource = new Map<string, string[]>();
  const pending: string[] = [];

  for (const edge of edges) {
    const targets = targetsBySource.get(edge.source);
    if (targets) {
      targets.push(edge.target);
    } else {
      targetsBySource.set(edge.source, [edge.target]);
    }

    if (entryNodeIds.has(edge.source) && edge.sourceHandle === outlet) {
      pending.push(edge.target);
    }
  }

  const behind = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || behind.has(nodeId)) {
      continue;
    }
    behind.add(nodeId);
    pending.push(...(targetsBySource.get(nodeId) ?? []));
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
