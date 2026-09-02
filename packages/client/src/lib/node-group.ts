/**
 * Apply and undo a Group on editor nodes: relative positions, compact child
 * size, and React Flow parent constraints. Analysis lives in shared.
 */

import { nanoid } from "nanoid";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { toast } from "sonner";
import type { EdgeChange } from "@xyflow/react";
import { isConditionNode } from "@wfgraph/shared/graph/node-config";
import {
  analyzeGroupableSelection,
  childIdsOfGroup,
  fanOutStoreEdgeIds,
  groupEntryIds,
  groupInteriorLayout,
  isEdgeBetweenMembers,
  isGroupNode,
  isInteriorEdge,
  orderGroupParentsFirst,
  predecessorKey,
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
  createEdgeId?: () => string;
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
  const interior = input.edges.filter((edge) =>
    isEdgeBetweenMembers(memberSet, edge)
  );
  const { slots, bounds } = groupInteriorLayout(
    analysis.memberIds,
    interior,
    analysis.entryIds
  );
  const size = groupFrameSize(bounds.columns, bounds.rows);
  const groupId = (input.createId ?? nanoid)();
  const positionById = childPositions(slots, bounds.columns);
  const conditionExit = analysis.exitIds
    .map((id) => byId.get(id))
    .find((node) => isConditionNode(node));

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
      config: {
        entryNodeIds: analysis.entryIds,
        exitNodeIds: analysis.exitIds,
        ...(conditionExit ? { outletHandle: "true" as const } : {}),
      },
    },
  };

  // Disabled belongs to the frame, and a frame reads disabled only when every
  // member is. Grouping one step that was already switched off therefore takes
  // the whole frame with it, which is the safe direction: the other reading
  // would run a step the person had turned off.
  const disabled = members.some((node) => node.data.enabled === false);
  const children = members.map((node) =>
    nestInGroup(
      disabled ? { ...node, data: { ...node.data, enabled: false } } : node,
      groupId,
      childPosition(positionById, node.id)
    )
  );
  const rest = input.nodes
    .filter((node) => !memberSet.has(node.id))
    .map((node) => ({ ...node, selected: false }));

  return {
    // Sorted rather than appended, because `rest` already holds any earlier
    // frame and its members. Appending here would put the new frame after those
    // members, and `displayNodesAtom` would then re-sort on every render.
    nodes: orderGroupParentsFirst([...rest, groupNode, ...children]),
    edges: alignEntryIncoming({
      edges: input.edges,
      entryIds: analysis.entryIds,
      createEdgeId: input.createEdgeId ?? nanoid,
    }),
    analysis,
  };
}

export function ungroupNode(
  nodes: WorkflowNode[],
  groupId: string
): WorkflowNode[] {
  const group = nodes.find((node) => node.id === groupId);
  if (!group || !isGroupNode(group)) {
    return nodes;
  }

  // Sorted for the same reason `groupSelection` is: the freed members stay
  // where the frame stood, which puts them ahead of any frame that remains.
  return orderGroupParentsFirst(
    nodes.flatMap((node) => {
      if (node.id === groupId) {
        return [];
      }
      if (node.parentId !== groupId) {
        return [node];
      }
      return [unnestFromGroup(node, freedPosition(group, node))];
    })
  );
}

export function layoutGroupChildren(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowNode[] {
  const byParent = new Map<string, WorkflowNode[]>();
  for (const node of nodes) {
    if (!node.parentId) {
      continue;
    }
    const current = byParent.get(node.parentId) ?? [];
    current.push(node);
    byParent.set(node.parentId, current);
  }

  if (byParent.size === 0) {
    return nodes;
  }

  const childById = new Map<string, WorkflowNode>();
  const sizeByGroup = new Map<string, { width: number; height: number }>();
  for (const [groupId, children] of byParent) {
    const group = nodes.find((node) => node.id === groupId);
    const memberIds = children.map((child) => child.id);
    const memberSet = new Set(memberIds);
    const interior = edges.filter((edge) =>
      isEdgeBetweenMembers(memberSet, edge)
    );
    const { slots, bounds } = groupInteriorLayout(
      memberIds,
      interior,
      groupEntryIds(group)
    );
    sizeByGroup.set(groupId, groupFrameSize(bounds.columns, bounds.rows));
    const positionById = childPositions(slots, bounds.columns);
    for (const child of children) {
      childById.set(
        child.id,
        nestInGroup(child, groupId, childPosition(positionById, child.id))
      );
    }
  }

  return nodes.map((node) => {
    if (isGroupNode(node)) {
      const size = sizeByGroup.get(node.id);
      if (!size) {
        return node;
      }
      return {
        ...node,
        width: size.width,
        height: size.height,
        style: { ...node.style, width: size.width, height: size.height },
      };
    }
    return childById.get(node.id) ?? node;
  });
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

export function dissolveUndersizedGroups(
  nodes: WorkflowNode[]
): WorkflowNode[] {
  let next = nodes;
  for (const groupId of undersizedGroupIds(next)) {
    next = ungroupNode(next, groupId);
  }
  return next;
}

/**
 * Why this batch cannot be deleted, or null when it can. A frame's entry ids
 * and exit ids are derived from the members it was built from, so a member that
 * goes without its frame leaves a config naming a step that is gone, and the
 * next edge painted off the frame names it too. A batch holding the frame is
 * allowed, because the frame takes its members with it; see `idsRemovedWith`.
 *
 * Every delete path asks this one question, with a batch of one where it has
 * one node, so the delete key, the context menu, and the panel cannot disagree.
 * Marking a member `deletable: false` instead would not do: React Flow drops
 * such a node before it expands a frame into its children, which would delete
 * the frame and leave its members pointing at a frame that is gone.
 */
export function refuseDelete(batch: readonly WorkflowNode[]): string | null {
  const frameIds = new Set(
    batch.filter((node) => isGroupNode(node)).map((node) => node.id)
  );
  const stranded = batch.some(
    (node) => node.parentId && !frameIds.has(node.parentId)
  );
  return stranded ? "Ungroup the frame before deleting a step inside it" : null;
}

/**
 * `refuseDelete` for the paths that act rather than render: the delete key and
 * the panel's Delete button both cancel the whole batch and say why. Refusing
 * without a word is what let those two paths disagree, one deleting the rest of
 * the selection while the other deleted nothing.
 */
export function refuseDeleteWithNotice(
  batch: readonly WorkflowNode[]
): string | null {
  const refusal = refuseDelete(batch);
  if (refusal) {
    toast.error(refusal);
  }
  return refusal;
}

/** Whether this step has a frame to leave: a frame itself, or a member. */
export function canUngroup(node: WorkflowNode | undefined): boolean {
  return Boolean(node && (isGroupNode(node) || node.parentId));
}

export function idsRemovedWith(
  nodes: readonly WorkflowNode[],
  nodeId: string
): Set<string> {
  const ids = new Set([nodeId]);
  const target = nodes.find((node) => node.id === nodeId);
  if (isGroupNode(target)) {
    for (const childId of childIdsOfGroup(nodes, nodeId)) {
      ids.add(childId);
    }
  }
  return ids;
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
 * Drop the edges whose source or target is no longer a node, which the graph
 * has to be free of before `createSerializedWorkflowGraph` will take it.
 *
 * React Flow asks for no edge it was told it cannot delete, and a frame's
 * interior edges are painted `deletable: false` by `lockGroupInteriorEdges`; a
 * collapsed inlet edge never reaches it at all. Deleting a frame therefore
 * removes its children and leaves both kinds behind. Returns the same array
 * when every edge still has both ends.
 */
export function dropOrphanedEdges(
  nodes: readonly WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowEdge[] {
  const liveIds = new Set(nodes.map((node) => node.id));
  const kept = edges.filter(
    (edge) => liveIds.has(edge.source) && liveIds.has(edge.target)
  );
  return kept.length === edges.length ? edges : kept;
}

function alignEntryIncoming(input: {
  edges: WorkflowEdge[];
  entryIds: readonly string[];
  createEdgeId: () => string;
}): WorkflowEdge[] {
  const { edges, entryIds, createEdgeId } = input;
  const entrySet = new Set(entryIds);
  const incoming = edges.filter((edge) => entrySet.has(edge.target));
  const templates: WorkflowEdge[] = [];
  const seen = new Set<string>();
  for (const edge of incoming) {
    const key = predecessorKey(edge);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    templates.push(edge);
  }
  if (templates.length !== 1) {
    return edges;
  }

  const template = templates[0];
  if (!template) {
    return edges;
  }
  const templateKey = predecessorKey(template);
  const have = new Set(
    edges
      .filter((edge) => predecessorKey(edge) === templateKey)
      .map((edge) => edge.target)
  );
  const extra: WorkflowEdge[] = [];
  for (const entryId of entryIds) {
    if (have.has(entryId)) {
      continue;
    }
    // No `type`: the canvas names the edge component for every edge through
    // `defaultEdgeOptions`, and React Flow merges that under the edge, so an
    // explicit `type: undefined` here would shadow it back to the bezier.
    // React Flow declares both handle keys as plain optional, so a handle the
    // template does not name is left out rather than written as `undefined`.
    extra.push(
      omitUndefined({
        id: createEdgeId(),
        source: template.source,
        target: entryId,
        sourceHandle: template.sourceHandle,
        targetHandle: template.targetHandle,
      })
    );
  }
  return extra.length === 0 ? edges : [...edges, ...extra];
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
  const widthOfRow = new Map<number, number>();
  for (const slot of slots) {
    widthOfRow.set(slot.row, (widthOfRow.get(slot.row) ?? 0) + 1);
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const slot of slots) {
    const spare = columns - (widthOfRow.get(slot.row) ?? 1);
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
function freedPosition(
  group: WorkflowNode,
  child: WorkflowNode
): { x: number; y: number } {
  if (typeof group.width !== "number") {
    throw new Error(`Group '${group.id}' has no width to ungroup around`);
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

function unnestFromGroup(
  node: WorkflowNode,
  position: { x: number; y: number }
): WorkflowNode {
  const { extent: _extent, parentId: _parentId, ...rest } = node;
  return {
    ...rest,
    draggable: true,
    connectable: true,
    width: WORKFLOW_NODE_WIDTH,
    height: WORKFLOW_NODE_HEIGHT,
    position,
  };
}
