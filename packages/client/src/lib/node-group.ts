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
  isGroupNode,
} from "@wfgraph/shared/graph/group-boundary";
import {
  dissolveGroups,
  type GroupRepair,
  positionInFrame,
  repairGroups,
} from "@wfgraph/shared/graph/group-dissolution";
import {
  analyzeGroupableSelection,
  childIdsOfGroup,
  fanOutStoreEdgeIds,
  groupInteriorLayout,
  isInteriorEdge,
  orderGroupParentsFirst,
  undersizedGroupIds,
  type GroupAnalysis,
  type GroupMemberSlot,
} from "@wfgraph/shared/graph/node-group";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  GROUP_CHILD_HEIGHT,
  GROUP_CHILD_WIDTH,
  GROUP_COLUMN_GAP,
  GROUP_HEADER_HEIGHT,
  GROUP_PAD,
  GROUP_ROW_GAP,
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
  groupFrameSize,
} from "#src/lib/workflow-node-dimensions";

/**
 * How much wider one step of the outer canvas is than the compact card a frame
 * packs it into. Ungrouping scales a member's offset from the frame's centre by
 * these, which is what makes the shape a person read inside the frame survive.
 */
const COLUMN_PITCH_RATIO =
  (WORKFLOW_NODE_WIDTH + NODE_SPACING) / (GROUP_CHILD_WIDTH + GROUP_COLUMN_GAP);
const ROW_PITCH_RATIO =
  (WORKFLOW_NODE_HEIGHT + RANK_SPACING) / (GROUP_CHILD_HEIGHT + GROUP_ROW_GAP);

export function groupSelection(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedIds: ReadonlySet<string>;
  /** Read for `sideEffect`, which decides whether a step may join a frame. */
  catalog: ExtensionCatalog;
  createId?: () => string;
}): {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  analysis: GroupAnalysis;
} | null {
  const analysis = analyzeGroupableSelection(
    input.nodes,
    input.edges,
    input.selectedIds,
    input.catalog
  );
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
  const size = groupFrameSize(bounds.columns, bounds.rows);
  const groupId = (input.createId ?? generateId)();
  const positionById = childPositions(slots, bounds.columns);

  const groupNode: WorkflowNode = {
    id: groupId,
    type: "group",
    position: origin,
    width: size.width,
    height: size.height,
    style: { width: size.width, height: size.height },
    selected: true,
    data: {
      label: "Group",
      type: "group",
    },
  };

  // Each member keeps its own data, so grouping leaves every step's enabled
  // state and configuration exactly as they were.
  const children = members.map((node) =>
    nestInGroup(node, groupId, childPosition(positionById, node.id))
  );
  const rest = input.nodes
    .filter((node) => !memberSet.has(node.id))
    .map((node) => ({ ...node, selected: false }));

  return {
    // Sorted rather than appended, because `rest` already holds any earlier
    // frame and its members. Appending here would put the new frame after those
    // members, and `displayNodesAtom` would then re-sort on every render.
    nodes: orderGroupParentsFirst([...rest, groupNode, ...children]),
    // Grouping writes membership only. The stored edges are the engine's
    // traversal graph, so the Group's boundary is read off them unchanged.
    edges: input.edges,
    analysis,
  };
}

/**
 * Remove the frame `groupId` and free its members on the open canvas, keeping
 * every stored edge. Answers `nodes` itself when `groupId` names no frame.
 */
export function ungroupNode(
  nodes: WorkflowNode[],
  groupId: string
): WorkflowNode[] {
  return ungroupFrames(nodes, new Set([groupId]));
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
  const repair = repairGroups({ ...input, releaseMember });
  return repair.ok
    ? { ...repair, nodes: orderGroupParentsFirst(repair.nodes) }
    : repair;
}

/**
 * One locked copy per store edge, so a recompute that changed nothing hands
 * React Flow the same object it saw last time. The three flags never vary, so
 * a cached copy cannot go stale: an edge that stops being interior fails the
 * check above the cache and comes back untouched.
 */
const lockedInteriorEdges = new WeakMap<WorkflowEdge, WorkflowEdge>();

/**
 * Mark the edges between two members of one frame as display only. They paint
 * so the interior fan-out and its join can be read, and the frame owns every
 * edit: deleting one would strand a member the analysis proved connected.
 * Returns the same array when no edge is interior.
 */
export function lockGroupInteriorEdges(
  nodes: readonly WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowEdge[] {
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  const parentOf = (nodeId: string) => parentById.get(nodeId);
  let locked = false;
  const next = edges.map((edge) => {
    if (!isInteriorEdge(parentOf, edge)) {
      return edge;
    }
    locked = true;
    const cached = lockedInteriorEdges.get(edge);
    if (cached) {
      return cached;
    }
    const lockedEdge: WorkflowEdge = {
      ...edge,
      selectable: false,
      deletable: false,
      focusable: false,
    };
    lockedInteriorEdges.set(edge, lockedEdge);
    return lockedEdge;
  });
  return locked ? next : edges;
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
  return {
    nodes: ungroupFrames(
      remaining,
      new Set([...frameIds, ...undersizedGroupIds(remaining)])
    ),
    edges: removeEdgesTouching(input.edges, removedIds),
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

export function expandEdgeRemovals(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  changes: EdgeChange[]
): EdgeChange[] {
  const removedIds = new Set<string>();
  for (const change of changes) {
    if (change.type !== "remove") {
      continue;
    }
    for (const id of fanOutStoreEdgeIds(nodes, edges, change.id)) {
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
    selected: false,
    width: GROUP_CHILD_WIDTH,
    height: GROUP_CHILD_HEIGHT,
    position,
  };
}

/**
 * Where one freed member lands on the open canvas. The frame packs its members
 * into compact cards; a full-size node needs the pitch auto-layout gives one.
 *
 * `childPositions` places a member's centre a whole number of column pitches
 * either side of the frame's centre, and its top a whole number of row pitches
 * below the frame's first row. Both are linear, so stretching each offset by
 * the ratio of the two pitches rebuilds the same arrangement at canvas scale,
 * and the shape a person read inside the frame survives the ungroup.
 */
function freedPosition(input: { frame: WorkflowNode; member: WorkflowNode }): {
  x: number;
  y: number;
} {
  const { frame: group, member: child } = input;
  // A frame from a graph no editor has laid out yet has no width to scale
  // around, so its members keep the spot they drew at inside it.
  if (typeof group.width !== "number") {
    return positionInFrame(input);
  }
  const frameCentreX = group.position.x + group.width / 2;
  const childCentreX =
    group.position.x + child.position.x + GROUP_CHILD_WIDTH / 2;
  const rowTop = child.position.y - GROUP_HEADER_HEIGHT - GROUP_PAD;

  return {
    x:
      frameCentreX +
      (childCentreX - frameCentreX) * COLUMN_PITCH_RATIO -
      WORKFLOW_NODE_WIDTH / 2,
    y: group.position.y + rowTop * ROW_PITCH_RATIO,
  };
}

/**
 * Dissolve the frames `groupIds` names and keep the frames-first order
 * `orderGroupParentsFirst` describes. Answers `nodes` when no id names a frame.
 */
function ungroupFrames(
  nodes: WorkflowNode[],
  groupIds: ReadonlySet<string>
): WorkflowNode[] {
  return orderGroupParentsFirst(
    dissolveGroups({ nodes, groupIds, releaseMember })
  );
}

/**
 * The node a member becomes on the open canvas once its frame is gone: a
 * full-size card at `freedPosition`, draggable and connectable, with no parent
 * constraint.
 */
function releaseMember(input: {
  frame: WorkflowNode;
  member: WorkflowNode;
}): WorkflowNode {
  const { extent: _extent, parentId: _parentId, ...rest } = input.member;
  return {
    ...rest,
    draggable: true,
    connectable: true,
    width: WORKFLOW_NODE_WIDTH,
    height: WORKFLOW_NODE_HEIGHT,
    position: freedPosition(input),
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
