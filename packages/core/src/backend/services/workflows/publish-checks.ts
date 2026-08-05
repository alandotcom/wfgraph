/**
 * Extra refusals the publish gate runs beyond ordinary graph+catalog soundness.
 *
 * An unreachable subtree is skipped at run time; a Canceled branch with no
 * Cancel Event is drawable and never entered (the editor shows it inactive).
 */

import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
  nodesBehindOutlet,
} from "@rova/shared/lifecycle/lifecycle-outlets";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/graph/types";

export type PublishCheckResult =
  | { valid: true }
  | { valid: false; error: string };

/**
 * Every node the Lifecycle Node can reach through Started or Canceled, plus the
 * entry nodes themselves. Anything else is an orphan the engine never schedules.
 */
export function reachableNodeIds(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): Set<string> {
  const entryNodeIds = new Set(
    input.nodes
      .filter((node) => node.data.type === "lifecycle")
      .map((node) => node.id)
  );

  const reachable = new Set(entryNodeIds);
  for (const outlet of [
    LIFECYCLE_STARTED_HANDLE,
    LIFECYCLE_CANCELED_HANDLE,
  ] as const) {
    for (const nodeId of nodesBehindOutlet({
      entryNodeIds,
      outlet,
      edges: input.edges,
    })) {
      reachable.add(nodeId);
    }
  }

  return reachable;
}

/**
 * Refuse a graph that stores nodes the entry can never schedule.
 *
 * Deleting a node mid-chain orphans everything below it; the graph saves clean
 * and every run skips the orphans in silence.
 */
export function checkUnreachableSubtrees(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): PublishCheckResult {
  const reachable = reachableNodeIds(input);
  const orphans = input.nodes
    .filter((node) => !reachable.has(node.id))
    .map((node) => node.data.label || node.id);

  if (orphans.length === 0) {
    return { valid: true };
  }

  const named =
    orphans.length === 1
      ? `"${orphans[0]}"`
      : `${orphans.length} nodes (including "${orphans[0]}")`;

  return {
    valid: false,
    error: `Unreachable ${named}: nothing from the Lifecycle Node reaches them. Connect them or delete them before publishing.`,
  };
}
