/**
 * Group mutations on editor nodes: grouping, ungrouping, and the removals that
 * touch a Group. Each keeps React Flow's parent fields in step with `parentId`.
 * Analysis and dissolution live in shared.
 */

import { countBy } from "es-toolkit/array";
import { generateId } from "@wfgraph/shared/utils/id";
import type { EdgeChange } from "@xyflow/react";
import {
  analyzeGroupBoundary,
  analyzeGroupBoundaryById,
  isGroupNode,
} from "@wfgraph/shared/graph/group-boundary";
import {
  dissolveGroups,
  type GroupRepair,
  type ReleaseMember,
  repairGroups,
} from "@wfgraph/shared/graph/group-dissolution";
import {
  analyzeGroupableSelection,
  childIdsOfGroup,
  fanOutStoreEdgeIds,
  groupCanvasPositions,
  groupInteriorLayout,
  groupLayoutDirection,
  orderGroupParentsFirst,
  undersizedGroupIds,
  type GroupAnalysis,
  type GroupMemberSlot,
} from "@wfgraph/shared/graph/node-group";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import type { WorkspaceScope } from "#src/lib/workflow-navigation-state";
import {
  GROUP_CHILD_HEIGHT,
  GROUP_CHILD_WIDTH,
  GROUP_COLUMN_GAP,
  GROUP_HEADER_HEIGHT,
  GROUP_PAD,
  GROUP_ROW_GAP,
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
  const { interiorEdges } = analyzeGroupBoundary({
    memberIds: analysis.memberIds,
    edges: input.edges,
  });
  const { slots, bounds } = groupInteriorLayout(
    analysis.memberIds,
    interiorEdges
  );
  // The overview draws a Group as one collapsed card.
  const size = workflowNodeSize();
  const groupId = (input.createId ?? generateId)();
  const positionById = childPositions(slots, bounds.columns);

  const groupNode: WorkflowNode = {
    id: groupId,
    type: "group",
    position: origin,
    width: size.width,
    height: size.height,
    style: { width: size.width, height: size.height },
    // A new Group is laid out top to bottom until its direction is changed.
    data: {
      label: "Group",
      type: "group",
      config: { direction: "vertical" },
    },
  };

  // Each member keeps its own data, so grouping leaves every step's enabled
  // state and configuration exactly as they were.
  const children = members.map((node) =>
    nestInGroup(node, groupId, childPosition(positionById, node.id))
  );
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
  edges: readonly WorkflowEdge[];
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
      edges,
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
 * `changes` with each removal replaced by removals of the stored edges
 * `storedEdgeIdsForPaintedEdge` says it stands for in `scope`.
 */
export function expandEdgeRemovals(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  changes: EdgeChange[],
  scope: WorkspaceScope
): EdgeChange[] {
  const removedIds = new Set<string>();
  for (const change of changes) {
    if (change.type !== "remove") {
      continue;
    }
    for (const id of storedEdgeIdsForPaintedEdge({
      nodes,
      edges,
      edgeId: change.id,
      scope,
    })) {
      removedIds.add(id);
    }
  }
  if (removedIds.size === 0) {
    return changes;
  }
  return [
    ...changes.filter((change) => change.type !== "remove"),
    ...[...removedIds].map((id) => ({ type: "remove" as const, id })),
  ];
}

/**
 * Where each member draws inside the frame. A row narrower than the widest one
 * is centred, so the step several parallel lookups join at sits under all of
 * them and the interior edges read as a fan-in rather than a stack.
 */
function childPositions(
  slots: readonly GroupMemberSlot[],
  columns: number
): Map<string, { x: number; y: number }> {
  const widthOfRow = countBy(slots, (slot) => slot.row);

  const positions = new Map<string, { x: number; y: number }>();
  for (const slot of slots) {
    const spare = columns - (widthOfRow[slot.row] ?? 1);
    const indent = (spare * (GROUP_CHILD_WIDTH + GROUP_COLUMN_GAP)) / 2;
    positions.set(slot.id, {
      x:
        GROUP_PAD +
        indent +
        slot.column * (GROUP_CHILD_WIDTH + GROUP_COLUMN_GAP),
      y:
        GROUP_HEADER_HEIGHT +
        GROUP_PAD +
        slot.row * (GROUP_CHILD_HEIGHT + GROUP_ROW_GAP),
    });
  }
  return positions;
}

/**
 * `childPositions` is built from the slots of the very members being placed, so
 * a miss means the two disagree about who is in the frame. Fail there rather
 * than stack every affected member on one point and call it a layout.
 */
function childPosition(
  positions: ReadonlyMap<string, { x: number; y: number }>,
  nodeId: string
): { x: number; y: number } {
  const position = positions.get(nodeId);
  if (!position) {
    throw new Error(`Group layout has no slot for member '${nodeId}'`);
  }
  return position;
}

function nestInGroup(
  node: WorkflowNode,
  groupId: string,
  position: { x: number; y: number }
): WorkflowNode {
  return {
    ...node,
    parentId: groupId,
    extent: "parent",
    draggable: false,
    connectable: false,
    width: GROUP_CHILD_WIDTH,
    height: GROUP_CHILD_HEIGHT,
    position,
  };
}

/**
 * Dissolve the frames `groupIds` names and keep the frames-first order
 * `orderGroupParentsFirst` describes. Answers `nodes` when no id names a frame.
 */
function ungroupFrames(input: {
  nodes: WorkflowNode[];
  edges: readonly WorkflowEdge[];
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
 * constraint, draggable and connectable whenever the canvas allows it. It
 * lands where the focused Group canvas draws it, moved so the Group's slots are
 * centred on the collapsed card's centre line and its first row starts at the
 * card's top, along the frame's stored layout direction. The layout of each
 * frame is computed once, from `nodes` and `edges` as they were given.
 */
function memberReleaser(graph: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): ReleaseMember<WorkflowNode> {
  const positionsByFrame = new Map<
    string,
    Map<string, { x: number; y: number }>
  >();
  return ({ frame, member }) => {
    let positions = positionsByFrame.get(frame.id);
    if (!positions) {
      const { memberIds, interiorEdges } = analyzeGroupBoundaryById({
        nodes: graph.nodes,
        edges: graph.edges,
        groupId: frame.id,
      });
      positions = groupCanvasPositions({
        memberIds,
        interiorEdges,
        direction: groupLayoutDirection(frame),
      });
      positionsByFrame.set(frame.id, positions);
    }
    const offset = positions.get(member.id) ?? {
      x: -WORKFLOW_NODE_WIDTH / 2,
      y: 0,
    };
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
      position: {
        x: frame.position.x + WORKFLOW_NODE_WIDTH / 2 + offset.x,
        y: frame.position.y + offset.y,
      },
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
