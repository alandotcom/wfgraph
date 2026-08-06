/**
 * When no Cancel Event is declared, the Canceled branch is drawable but the
 * engine never enters it. The editor mutes that subtree so publish need not
 * refuse the graph.
 */

import {
  LIFECYCLE_CANCELED_HANDLE,
  nodesBehindOutlet,
} from "@rova/shared/lifecycle/lifecycle-outlets";
import { configDeclaresCancelEvent } from "@rova/shared/lifecycle/lifecycle-rules";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export type InactiveCanceledBranch = {
  nodeIds: ReadonlySet<string>;
  /** Every edge in the inactive Canceled subtree (outlet + downstream). */
  edgeIds: ReadonlySet<string>;
  /** Edges leaving the Canceled handle — the only ones that get a label. */
  outletEdgeIds: ReadonlySet<string>;
};

const EMPTY: InactiveCanceledBranch = {
  nodeIds: new Set(),
  edgeIds: new Set(),
  outletEdgeIds: new Set(),
};

/**
 * Node and edge ids behind every Canceled outlet when no Lifecycle Node
 * declares a Cancel Event. Empty when any Cancel Event exists, or when nothing
 * hangs off Canceled.
 */
export function inactiveCanceledBranch(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): InactiveCanceledBranch {
  const lifecycleNodes = input.nodes.filter(
    (node) => node.data.type === "lifecycle"
  );

  if (lifecycleNodes.length === 0) {
    return EMPTY;
  }

  const hasCancelEvent = lifecycleNodes.some((node) =>
    configDeclaresCancelEvent(node.data.config)
  );
  if (hasCancelEvent) {
    return EMPTY;
  }

  const entryNodeIds = new Set(lifecycleNodes.map((node) => node.id));
  const nodeIds = nodesBehindOutlet({
    entryNodeIds,
    outlet: LIFECYCLE_CANCELED_HANDLE,
    edges: input.edges,
  });

  if (nodeIds.size === 0) {
    return EMPTY;
  }

  const edgeIds = new Set<string>();
  const outletEdgeIds = new Set<string>();
  for (const edge of input.edges) {
    const leavesCanceledOutlet =
      entryNodeIds.has(edge.source) &&
      edge.sourceHandle === LIFECYCLE_CANCELED_HANDLE;
    if (leavesCanceledOutlet) {
      outletEdgeIds.add(edge.id);
      edgeIds.add(edge.id);
      continue;
    }
    if (nodeIds.has(edge.source)) {
      edgeIds.add(edge.id);
    }
  }

  return { nodeIds, edgeIds, outletEdgeIds };
}
