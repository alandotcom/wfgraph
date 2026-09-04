import { countBy } from "es-toolkit/array";
import {
  groupEntryIds,
  groupInteriorLayout,
  isEdgeBetweenMembers,
  isGroupNode,
  type GroupMemberSlot,
} from "#src/graph/node-group";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import {
  GROUP_CHILD_HEIGHT,
  GROUP_CHILD_WIDTH,
  GROUP_COLUMN_GAP,
  GROUP_HEADER_HEIGHT,
  GROUP_PAD,
  GROUP_ROW_GAP,
  groupFrameSize,
} from "#src/graph/workflow-layout-geometry";

/** Returns each Group member's persisted position and compact dimensions. */
export function layoutGroupChildren(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowNode[] {
  const nested = nodes.filter(
    (node): node is WorkflowNode & { parentId: string } =>
      node.parentId !== undefined && node.parentId !== ""
  );
  // A Map preserves persisted ids such as `__proto__` as ordinary keys.
  const byParent = Map.groupBy(nested, (node) => node.parentId);

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
      childById.set(child.id, {
        ...child,
        parentId: groupId,
        width: GROUP_CHILD_WIDTH,
        height: GROUP_CHILD_HEIGHT,
        position: childPosition(positionById, child.id),
      });
    }
  }

  return nodes.map((node) => {
    if (isGroupNode(node)) {
      const size = sizeByGroup.get(node.id);
      return size ? { ...node, ...size } : node;
    }
    return childById.get(node.id) ?? node;
  });
}

/** Places each row's members around the centre of the widest Group row. */
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
