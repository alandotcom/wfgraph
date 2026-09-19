/**
 * Group mutations on editor nodes: grouping, ungrouping, and the removals that
 * touch a Group. Analysis, dissolution, and where a released member lands live
 * in shared.
 */

import { generateId } from "@wfgraph/shared/utils/id";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  dissolveGroups,
  groupCanvasReleasePosition,
  type GroupRepair,
  type ReleaseMember,
  repairGroups,
} from "@wfgraph/shared/graph/group-dissolution";
import {
  analyzeGroupableSelection,
  childIdsOfGroup,
  fanOutStoreEdgeIds,
  orderGroupParentsFirst,
  undersizedGroupIds,
  type GroupAnalysis,
} from "@wfgraph/shared/graph/node-group";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkspaceScope } from "#src/lib/workflow-navigation-state";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
  workflowNodeSize,
} from "#src/lib/workflow-node-dimensions";

export function groupSelection(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedIds: ReadonlySet<string>;
  createId?: () => string;
}): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** The id of the new frame. */
  groupId: string;
  analysis: GroupAnalysis;
} | null {
  const analysis = analyzeGroupableSelection(input);
  if (!analysis.ok) {
    return null;
  }

  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const members = analysis.memberIds.map((id) => {
    const node = byId.get(id);
    if (!node) {
      throw new Error("groupSelection expected analyzeGroupableSelection ids");
    }
    return node;
  });

  const origin = {
    x: Math.min(...members.map((node) => node.position.x)),
    y: Math.min(...members.map((node) => node.position.y)),
  };
  const memberSet = new Set(analysis.memberIds);
  // The overview draws a Group as one collapsed card.
  const size = workflowNodeSize();
  const groupId = (input.createId ?? generateId)();

  const groupNode: WorkflowNode = {
    id: groupId,
    type: "group",
    position: origin,
    width: size.width,
    height: size.height,
    style: { width: size.width, height: size.height },
    data: {
      label: "Group",
      type: "group",
    },
  };

  // Grouping preserves each step's data and size. Positions become local to
  // the frame; focus paints them unchanged and Ungroup translates them back.
  const children = members.map((node): WorkflowNode => ({
    ...node,
    parentId: groupId,
    position: {
      x: node.position.x - origin.x,
      y: node.position.y - origin.y,
    },
  }));
  const rest = input.nodes.filter((node) => !memberSet.has(node.id));

  return {
    // Sorted rather than appended, because `rest` already holds any earlier
    // frame and its members. Appending here would put the new frame after those
    // members, and `displayNodesAtom` would then re-sort on every render.
    nodes: orderGroupParentsFirst([...rest, groupNode, ...children]),
    // Grouping writes membership only. The stored edges are the engine's
    // traversal graph, so the Group's boundary is read off them unchanged.
    edges: input.edges,
    groupId,
    analysis,
  };
}

/**
 * Remove the frame `groupId` and free its members on the open canvas, keeping
 * every stored edge. Answers `nodes` itself when `groupId` names no frame.
 */
export function ungroupNode(input: {
  nodes: WorkflowNode[];
  groupId: string;
}): WorkflowNode[] {
  return ungroupFrames({ ...input, groupIds: new Set([input.groupId]) });
}

/**
 * `repairGroups` for a graph arriving on the open canvas from outside it: a
 * loaded draft or a build agent edit. Dissolved members are freed the way
 * `ungroupNode` frees them.
 */
export function repairCanvasGroups(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): GroupRepair<WorkflowNode[]> {
  const repair = repairGroups({
    ...input,
    releaseMember: memberReleaser(input),
  });
  return repair.ok
    ? { ...repair, nodes: orderGroupParentsFirst(repair.nodes) }
    : repair;
}

/**
 * Remove a batch of nodes as one graph change. A frame in the batch is
 * ungrouped, and a member the batch also names is removed, which is what a box
 * selection over a frame and some of its members asks for. Every removed node
 * goes with its stored edges, the Lifecycle Node stays, and a frame left
 * holding fewer than two steps is ungrouped. Deleting a Group with every step
 * inside it is `removeGroupWithMembers`. Answers the given arrays when the
 * batch changes nothing.
 */
export function removeNodes(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  nodeIds: ReadonlySet<string>;
}): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const batch = input.nodes.filter((node) => input.nodeIds.has(node.id));
  const frameIds = batch
    .filter((node) => isGroupNode(node))
    .map((node) => node.id);
  const removedIds = new Set(
    batch
      .filter((node) => !isGroupNode(node) && node.data.type !== "lifecycle")
      .map((node) => node.id)
  );

  const remaining =
    removedIds.size === 0
      ? input.nodes
      : input.nodes.filter((node) => !removedIds.has(node.id));
  const edges = removeEdgesTouching(input.edges, removedIds);
  return {
    nodes: ungroupFrames({
      nodes: remaining,
      groupIds: new Set([...frameIds, ...undersizedGroupIds(remaining)]),
    }),
    edges,
  };
}

/**
 * Remove the frame `groupId`, every member, and every stored edge touching a
 * member. Answers the given arrays when `groupId` names no frame.
 */
export function removeGroupWithMembers(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groupId: string;
}): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const frame = input.nodes.find((node) => node.id === input.groupId);
  if (!isGroupNode(frame)) {
    return { nodes: input.nodes, edges: input.edges };
  }
  const removedIds = new Set([
    input.groupId,
    ...childIdsOfGroup(input.nodes, input.groupId),
  ]);
  return {
    nodes: input.nodes.filter((node) => !removedIds.has(node.id)),
    edges: removeEdgesTouching(input.edges, removedIds),
  };
}

/** Whether this step has a frame to leave: a frame itself, or a member. */
export function canUngroup(node: WorkflowNode | undefined): boolean {
  return Boolean(node && (isGroupNode(node) || node.parentId));
}

/**
 * The stored edge ids that deleting the painted edge `edgeId` removes. On the
 * overview, a painted edge on a collapsed card stands for every stored edge
 * `fanOutStoreEdgeIds` collapses onto it. A focused Group paints each stored
 * edge under its own id, so there the painted edge is that one stored edge.
 * Empty when no stored edge has the id.
 */
export function storedEdgeIdsForPaintedEdge(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  edgeId: string;
  scope: WorkspaceScope;
}): string[] {
  if (input.scope.kind === "group") {
    return input.edges.some((edge) => edge.id === input.edgeId)
      ? [input.edgeId]
      : [];
  }
  return fanOutStoreEdgeIds(input.nodes, input.edges, input.edgeId);
}

/**
 * Dissolve the frames `groupIds` names and keep the frames-first order
 * `orderGroupParentsFirst` describes. Answers `nodes` when no id names a frame.
 */
function ungroupFrames(input: {
  nodes: WorkflowNode[];
  groupIds: ReadonlySet<string>;
}): WorkflowNode[] {
  return orderGroupParentsFirst(
    dissolveGroups({
      nodes: input.nodes,
      groupIds: input.groupIds,
      releaseMember: memberReleaser(input),
    })
  );
}

/**
 * Frees each member of a dissolved frame as a full-size card with no parent
 * constraint, draggable and connectable whenever the canvas allows it, at
 * `groupCanvasReleasePosition` for `graph`.
 */
function memberReleaser(graph: {
  nodes: readonly WorkflowNode[];
}): ReleaseMember<WorkflowNode> {
  const place = groupCanvasReleasePosition(graph);
  return ({ frame, member }) => {
    const {
      extent: _extent,
      parentId: _parentId,
      connectable: _connectable,
      draggable: _draggable,
      ...rest
    } = member;
    return {
      ...rest,
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
      position: place({ frame, member }),
    };
  };
}

/**
 * The stored edges with no end on a removed node, which the graph has to be free
 * of before `createSerializedWorkflowGraph` will take it. React Flow offers no
 * edge painted `deletable: false`, such as a member's interior edges, and no
 * stored edge its painted frame edge stands for, so every removal reads the
 * stored edges here. Answers `edges` itself when no edge touches `nodeIds`.
 */
function removeEdgesTouching(
  edges: WorkflowEdge[],
  nodeIds: ReadonlySet<string>
): WorkflowEdge[] {
  if (nodeIds.size === 0) {
    return edges;
  }
  const kept = edges.filter(
    (edge) => !nodeIds.has(edge.source) && !nodeIds.has(edge.target)
  );
  return kept.length === edges.length ? edges : kept;
}
