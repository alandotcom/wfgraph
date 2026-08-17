/**
 * Apply and undo a Group on editor nodes: relative positions, compact child
 * size, and React Flow parent constraints. Analysis lives in shared.
 */

import { nanoid } from "nanoid";
import type { EdgeChange } from "@xyflow/react";
import { isConditionNode } from "@wfgraph/shared/graph/node-config";
import {
  analyzeGroupableSelection,
  childIdsOfGroup,
  fanOutStoreEdgeIds,
  groupEntryIds,
  groupInteriorLayout,
  isGroupNode,
  predecessorKey,
  undersizedGroupIds,
  type GroupAnalysis,
  type GroupMemberSlot,
} from "@wfgraph/shared/graph/node-group";
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
} from "#src/components/workflow/workflow-node-dimensions";

/** Where a member draws when the layout somehow has no slot for it. */
const ORIGIN_SLOT = {
  x: GROUP_PAD,
  y: GROUP_HEADER_HEIGHT + GROUP_PAD,
} as const;

export function groupSelection(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedIds: ReadonlySet<string>;
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
    input.selectedIds
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
  const interior = input.edges.filter(
    (edge) => memberSet.has(edge.source) && memberSet.has(edge.target)
  );
  const { slots, bounds } = groupInteriorLayout(
    analysis.memberIds,
    interior,
    analysis.entryIds
  );
  const size = groupFrameSize(bounds.columns, bounds.rows);
  const groupId = (input.createId ?? nanoid)();
  const positionById = childPositions(slots, bounds.columns);
  const exit = byId.get(analysis.exitId);

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
        exitNodeId: analysis.exitId,
        ...(isConditionNode(exit) ? { outletHandle: "true" as const } : {}),
      },
    },
  };

  const children = members.map((node) =>
    nestInGroup(node, groupId, positionById.get(node.id) ?? ORIGIN_SLOT)
  );
  const rest = input.nodes
    .filter((node) => !memberSet.has(node.id))
    .map((node) => ({ ...node, selected: false }));

  return {
    nodes: [...rest, groupNode, ...children],
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

  const freed = freedPositions(
    group,
    nodes.filter((node) => node.parentId === groupId)
  );
  return nodes.flatMap((node) => {
    if (node.id === groupId) {
      return [];
    }
    if (node.parentId !== groupId) {
      return [node];
    }
    return [unnestFromGroup(node, freed.get(node.id) ?? group.position)];
  });
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
    const interior = edges.filter(
      (edge) => memberSet.has(edge.source) && memberSet.has(edge.target)
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
        nestInGroup(child, groupId, positionById.get(child.id) ?? ORIGIN_SLOT)
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
 * Mark the edges between two members of one frame as display only. They paint
 * so the interior fan-out and its join can be read, and the frame owns every
 * edit: deleting one would strand a member the analysis proved connected.
 * Returns the same array when the graph holds no group.
 */
export function lockGroupInteriorEdges(
  nodes: readonly WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowEdge[] {
  const parentById = new Map(nodes.map((node) => [node.id, node.parentId]));
  let locked = false;
  const next = edges.map((edge) => {
    const parent = parentById.get(edge.source);
    if (!parent || parent !== parentById.get(edge.target)) {
      return edge;
    }
    locked = true;
    return { ...edge, selectable: false, deletable: false, focusable: false };
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
 * Why this step cannot be deleted on its own, or null when it can. A frame's
 * entry ids and exit id are derived from the members it was built from, so
 * taking one out behind the frame's back leaves a config naming a step that is
 * gone, and the next edge painted off the frame names it too. Deleting the
 * frame still takes its members with it; see `idsRemovedWith`.
 */
export function refuseNodeDelete(
  nodes: readonly WorkflowNode[],
  nodeId: string
): string | null {
  const node = nodes.find((item) => item.id === nodeId);
  return node?.parentId ? "Ungroup the frame before deleting this step" : null;
}

/**
 * Whether every member in this batch goes with its own frame. React Flow's
 * `onBeforeDelete` answers for the whole batch rather than filtering it, so a
 * selection reaching into a frame without taking the frame cancels outright.
 * Marking a member undeletable instead would let React Flow delete the frame
 * and leave its members behind, pointing at a frame that is gone.
 */
export function deletesMembersWithTheirFrame(
  batch: readonly WorkflowNode[]
): boolean {
  const frameIds = new Set(
    batch.filter((node) => isGroupNode(node)).map((node) => node.id)
  );
  return batch.every((node) => !node.parentId || frameIds.has(node.parentId));
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
    extra.push({
      id: createEdgeId(),
      source: template.source,
      target: entryId,
      sourceHandle: template.sourceHandle,
      targetHandle: template.targetHandle,
      type: template.type,
    });
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
 * Where each freed member lands on the open canvas. The frame packs its members
 * into compact cards; a full-size node needs the pitch auto-layout gives one, so
 * the rows are rebuilt at that pitch around the frame's own centre and the
 * shape a person read inside the frame survives the ungroup.
 */
function freedPositions(
  group: WorkflowNode,
  children: readonly WorkflowNode[]
): Map<string, { x: number; y: number }> {
  const rows = new Map<number, WorkflowNode[]>();
  for (const child of children) {
    const row = rows.get(child.position.y) ?? [];
    row.push(child);
    rows.set(child.position.y, row);
  }

  const centreX = group.position.x + (group.width ?? WORKFLOW_NODE_WIDTH) / 2;
  const freed = new Map<string, { x: number; y: number }>();
  const orderedRows = [...rows.entries()].toSorted(([a], [b]) => a - b);
  for (const [index, [, row]] of orderedRows.entries()) {
    const ordered = row.toSorted((a, b) => a.position.x - b.position.x);
    for (const [column, child] of ordered.entries()) {
      const offset = column - (ordered.length - 1) / 2;
      freed.set(child.id, {
        x:
          centreX +
          offset * (WORKFLOW_NODE_WIDTH + NODE_SPACING) -
          WORKFLOW_NODE_WIDTH / 2,
        y: group.position.y + index * (WORKFLOW_NODE_HEIGHT + RANK_SPACING),
      });
    }
  }
  return freed;
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
