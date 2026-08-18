/**
 * Which nodes the engine can never reach on this graph, so the canvas can draw
 * them muted.
 *
 * Two things put a node out of reach. A Canceled subtree is drawable while no
 * Cancel Event is declared, and the run never enters it. A disabled step ends
 * its branch, so everything past it is stranded. A node is ready only when every
 * predecessor released it, which is why one downstream walk answers for a join
 * as well: an arm that never arrives holds the join for the life of the run.
 *
 * The answer is read against the painted graph, where a Group frame stands in
 * for its members, so a frame whose members are all out of reach is named here
 * too.
 */

import { descendantsOf } from "@wfgraph/shared/graph/descendants";
import { LIFECYCLE_CANCELED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import { configDeclaresCancelEvent } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export type InactiveBranch = {
  /** Nodes the run cannot reach. A disabled node itself is not one of them. */
  nodeIds: ReadonlySet<string>;
  /** Edges leaving the Canceled handle, the only ones that get a label. */
  outletEdgeIds: ReadonlySet<string>;
};

const EMPTY: InactiveBranch = {
  nodeIds: new Set(),
  outletEdgeIds: new Set(),
};

export function inactiveBranch(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): InactiveBranch {
  const canceledOutletEdges = deadCanceledOutletEdges(input);
  const disabledIds = input.nodes
    .filter((node) => node.data.enabled === false)
    .map((node) => node.id);

  if (canceledOutletEdges.length === 0 && disabledIds.length === 0) {
    return EMPTY;
  }

  // The node a dead outlet lands on is itself out of reach; a disabled node is
  // reached and skipped, so only what follows it is. One walk covers both.
  const nodeIds = new Set(canceledOutletEdges.map((edge) => edge.target));
  const starts = [...nodeIds, ...disabledIds];
  for (const nodeId of descendantsOf({
    startIds: starts,
    edges: input.edges,
  })) {
    nodeIds.add(nodeId);
  }

  addFramesStandingForLostMembers(input.nodes, nodeIds);

  if (nodeIds.size === 0) {
    return EMPTY;
  }

  return {
    nodeIds,
    outletEdgeIds: new Set(canceledOutletEdges.map((edge) => edge.id)),
  };
}

/**
 * The Canceled outlet edges of every Lifecycle Node, while none of them declares
 * a Cancel Event. Empty as soon as one does.
 */
function deadCanceledOutletEdges(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): WorkflowEdge[] {
  const lifecycleNodes = input.nodes.filter(
    (node) => node.data.type === "lifecycle"
  );

  if (
    lifecycleNodes.length === 0 ||
    lifecycleNodes.some((node) => configDeclaresCancelEvent(node.data.config))
  ) {
    return [];
  }

  const entryNodeIds = new Set(lifecycleNodes.map((node) => node.id));
  return input.edges.filter(
    (edge) =>
      entryNodeIds.has(edge.source) &&
      edge.sourceHandle === LIFECYCLE_CANCELED_HANDLE
  );
}

/**
 * Name the frame of a Group whose every member is out of reach.
 *
 * The store edge into a Group names a member, and the painted edge names the
 * frame instead, so without this the edge arriving at a dead Group draws live.
 * A frame whose members are merely disabled is left alone: the run does arrive
 * there, and the frame wears the disabled face for that.
 */
function addFramesStandingForLostMembers(
  nodes: readonly WorkflowNode[],
  nodeIds: Set<string>
): void {
  const lostByFrame = new Map<string, boolean>();
  for (const node of nodes) {
    if (!node.parentId) {
      continue;
    }
    const lost = nodeIds.has(node.id);
    lostByFrame.set(
      node.parentId,
      (lostByFrame.get(node.parentId) ?? true) && lost
    );
  }

  for (const [frameId, everyMemberLost] of lostByFrame) {
    if (everyMemberLost) {
      nodeIds.add(frameId);
    }
  }
}
