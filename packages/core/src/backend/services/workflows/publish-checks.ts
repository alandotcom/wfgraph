/**
 * Extra refusals the publish gate runs beyond ordinary graph+catalog soundness.
 *
 * Both are silent at run time today: an unreachable subtree is skipped, and a
 * Canceled branch with no Cancel Event is drawable but never entered.
 */

import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
  nodesBehindOutlet,
} from "@rova/shared/lifecycle/lifecycle-outlets";
import { readLifecycleRules } from "@rova/shared/lifecycle/lifecycle-rules";
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

/**
 * Refuse a Canceled branch on a workflow that declares no Cancel Event.
 *
 * `CancelBoundary` skips the boundary read entirely when no Cancel Event is
 * declared, so the branch is drawable and unreachable.
 */
export function checkCanceledBranchNeedsCancelEvent(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): PublishCheckResult {
  const lifecycleNodes = input.nodes.filter(
    (node) => node.data.type === "lifecycle"
  );
  const entryNodeIds = new Set(lifecycleNodes.map((node) => node.id));
  const canceledBranch = nodesBehindOutlet({
    entryNodeIds,
    outlet: LIFECYCLE_CANCELED_HANDLE,
    edges: input.edges,
  });

  if (canceledBranch.size === 0) {
    return { valid: true };
  }

  const hasCancelEvent = lifecycleNodes.some(
    (node) =>
      (readLifecycleRules(node.data.config)?.cancelEvents.length ?? 0) > 0
  );

  if (hasCancelEvent) {
    return { valid: true };
  }

  return {
    valid: false,
    error:
      "This workflow has a Canceled branch but declares no Cancel Event. Add a Cancel Event on the Lifecycle Node, or remove the Canceled branch, before publishing.",
  };
}
