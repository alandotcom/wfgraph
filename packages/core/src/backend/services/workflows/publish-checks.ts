/**
 * Extra refusals the publish gate runs beyond ordinary graph+catalog soundness.
 *
 * An unreachable subtree is skipped at run time; a Canceled branch with no
 * Cancel Event is drawable and never entered (the editor shows it inactive).
 */

import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
  type LifecycleOutlet,
  nodesBehindOutlet,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { configDeclaresCancelEvent } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";

export type PublishCheckResult =
  | { valid: true }
  | { valid: false; error: string };

const BOTH_OUTLETS: readonly LifecycleOutlet[] = [
  LIFECYCLE_STARTED_HANDLE,
  LIFECYCLE_CANCELED_HANDLE,
];

function lifecycleEntryIds(nodes: readonly WorkflowNode[]): Set<string> {
  return new Set(
    nodes
      .filter((node) => node.data.type === "lifecycle")
      .map((node) => node.id)
  );
}

function nodesBehindOutlets(input: {
  entryNodeIds: ReadonlySet<string>;
  outlets: readonly LifecycleOutlet[];
  edges: readonly WorkflowEdge[];
}): Set<string> {
  const reachable = new Set(input.entryNodeIds);
  for (const outlet of input.outlets) {
    for (const nodeId of nodesBehindOutlet({
      entryNodeIds: input.entryNodeIds,
      outlet,
      edges: input.edges,
    })) {
      reachable.add(nodeId);
    }
  }
  return reachable;
}

/**
 * Every node the engine can schedule from the Lifecycle Node: the entry nodes,
 * everything behind Started, and everything behind Canceled only when a Cancel
 * Event exists.
 */
export function reachableNodeIds(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): Set<string> {
  const includeCanceled = input.nodes.some(
    (node) =>
      node.data.type === "lifecycle" &&
      configDeclaresCancelEvent(node.data.config)
  );

  return nodesBehindOutlets({
    entryNodeIds: lifecycleEntryIds(input.nodes),
    outlets: includeCanceled ? BOTH_OUTLETS : [LIFECYCLE_STARTED_HANDLE],
    edges: input.edges,
  });
}

/**
 * Refuse nodes that hang off neither Lifecycle outlet.
 *
 * Deleting a node mid-chain orphans everything below it; the graph saves clean
 * and every run skips the orphans in silence.
 */
export function checkUnreachableSubtrees(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): PublishCheckResult {
  const connected = nodesBehindOutlets({
    entryNodeIds: lifecycleEntryIds(input.nodes),
    outlets: BOTH_OUTLETS,
    edges: input.edges,
  });
  const orphans = input.nodes
    .filter((node) => node.data.type !== "group" && !connected.has(node.id))
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
