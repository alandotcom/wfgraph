/**
 * The Lifecycle Node's outlets, named where both sides can read them, and the
 * walk that says which of them a node sits behind.
 *
 * The editor draws edges from a handle carrying one of these ids and the save
 * refuses an edge from the entry node that names none, so each string has one
 * owner. The Canceled outlet is drawn in stage 7; the name is here because the
 * walk below already answers for it, and a node behind it reads a different
 * payload from one behind Started.
 */

import type { WorkflowEdge } from "#src/workflow/types";
import { upstreamNodeIds } from "#src/workflow/upstream-nodes";

export const LIFECYCLE_STARTED_HANDLE = "started";
export const LIFECYCLE_CANCELED_HANDLE = "canceled";

/** Which outlet of the entry node a run came through to reach a given node. */
export type LifecycleOutlet =
  | typeof LIFECYCLE_STARTED_HANDLE
  | typeof LIFECYCLE_CANCELED_HANDLE;

function asLifecycleOutlet(
  sourceHandle: string | null | undefined
): LifecycleOutlet | null {
  if (sourceHandle === LIFECYCLE_STARTED_HANDLE) {
    return LIFECYCLE_STARTED_HANDLE;
  }

  return sourceHandle === LIFECYCLE_CANCELED_HANDLE
    ? LIFECYCLE_CANCELED_HANDLE
    : null;
}

/**
 * The outlets a run can have left the entry node through and still arrive at this
 * node.
 *
 * Both outlets answer for a node a diamond rejoins, and neither answers for a
 * node the entry node cannot reach at all. Callers read the size of the set as
 * much as its members: two outlets mean the node has to cope with either
 * payload, which is why its field list is the intersection of theirs.
 */
export function entryOutletsReaching(input: {
  entryNodeId: string;
  targetNodeId: string;
  edges: readonly WorkflowEdge[];
}): Set<LifecycleOutlet> {
  const { entryNodeId, targetNodeId, edges } = input;
  const upstream = upstreamNodeIds(targetNodeId, edges);
  const outlets = new Set<LifecycleOutlet>();

  for (const edge of edges) {
    if (edge.source !== entryNodeId) {
      continue;
    }

    // An outlet counts when its edge lands on the node asking, or on anything
    // upstream of it. The target is named separately because it is upstream of
    // nothing but itself.
    const onThePath = edge.target === targetNodeId || upstream.has(edge.target);
    if (!onThePath) {
      continue;
    }

    const outlet = asLifecycleOutlet(edge.sourceHandle);
    if (outlet) {
      outlets.add(outlet);
    }
  }

  return outlets;
}
