/**
 * Apply and undo a Group on editor nodes: relative positions, compact child
 * size, and React Flow parent constraints. Analysis lives in shared.
 */

import { nanoid } from "nanoid";
import {
  analyzeGroupableSelection,
  groupEntryIds,
  groupMemberSlots,
  groupSlotBounds,
  isGroupNode,
  type GroupAnalysis,
  type GroupMemberSlot,
} from "@wfgraph/shared/graph/node-group";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  GROUP_CHILD_GAP,
  GROUP_CHILD_HEIGHT,
  GROUP_CHILD_WIDTH,
  GROUP_HEADER_HEIGHT,
  GROUP_PAD,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
  groupFrameSize,
} from "#src/components/workflow/workflow-node-dimensions";

/** Which ids Group should wrap, given a click, a live selection, or a snapshot. */
export function selectionIdsForGrouping(
  nodes: readonly { id: string; selected?: boolean }[],
  target?: string | ReadonlySet<string>
): Set<string> {
  if (target instanceof Set) {
    return new Set(target);
  }

  const clickedNodeId = typeof target === "string" ? target : undefined;
  const clicked = clickedNodeId
    ? nodes.find((node) => node.id === clickedNodeId)
    : undefined;
  if (clickedNodeId && clicked && !clicked.selected) {
    return new Set([clickedNodeId]);
  }
  return new Set(nodes.filter((node) => node.selected).map((node) => node.id));
}

/**
 * Right-click often lands after the multi-select has already collapsed to the
 * clicked node. If the frozen ids still include that node, Group those.
 */
export function groupingIdsFromSnapshot(
  nodes: readonly { id: string; selected?: boolean }[],
  clickedNodeId: string | undefined,
  snapshotIds: readonly string[] | undefined
): Set<string> {
  if (
    clickedNodeId &&
    snapshotIds &&
    snapshotIds.length > 1 &&
    snapshotIds.includes(clickedNodeId)
  ) {
    return new Set(snapshotIds);
  }
  return selectionIdsForGrouping(nodes, clickedNodeId);
}

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
  const slots = groupMemberSlots(
    analysis.memberIds,
    interior,
    analysis.entryIds
  );
  const bounds = groupSlotBounds(slots);
  const size = groupFrameSize(bounds.columns, bounds.rows);
  const groupId = (input.createId ?? nanoid)();
  const slotById = new Map(slots.map((slot) => [slot.id, slot]));

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
      },
    },
  };

  const children = members.map((node) => {
    const slot = slotById.get(node.id) ?? { id: node.id, row: 0, column: 0 };
    return nestInGroup(node, groupId, slot);
  });
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

  const origin = group.position;
  return nodes.flatMap((node) => {
    if (node.id === groupId) {
      return [];
    }
    if (node.parentId !== groupId) {
      return [node];
    }
    return [unnestFromGroup(node, origin)];
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
    const slots = groupMemberSlots(memberIds, interior, groupEntryIds(group));
    const bounds = groupSlotBounds(slots);
    sizeByGroup.set(groupId, groupFrameSize(bounds.columns, bounds.rows));
    const slotById = new Map(slots.map((slot) => [slot.id, slot]));
    for (const child of children) {
      const slot = slotById.get(child.id) ?? {
        id: child.id,
        row: 0,
        column: 0,
      };
      childById.set(child.id, nestInGroup(child, groupId, slot));
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
    const key = `${edge.source}\0${edge.sourceHandle ?? ""}`;
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
  const have = new Set(
    edges
      .filter(
        (edge) =>
          edge.source === template.source &&
          (edge.sourceHandle ?? "") === (template.sourceHandle ?? "")
      )
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

function nestInGroup(
  node: WorkflowNode,
  groupId: string,
  slot: GroupMemberSlot
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
    position: {
      x: GROUP_PAD + slot.column * (GROUP_CHILD_WIDTH + GROUP_CHILD_GAP),
      y:
        GROUP_HEADER_HEIGHT +
        GROUP_PAD +
        slot.row * (GROUP_CHILD_HEIGHT + GROUP_CHILD_GAP),
    },
  };
}

function unnestFromGroup(
  node: WorkflowNode,
  origin: { x: number; y: number }
): WorkflowNode {
  const { extent: _extent, parentId: _parentId, ...rest } = node;
  return {
    ...rest,
    draggable: true,
    connectable: true,
    width: WORKFLOW_NODE_WIDTH,
    height: WORKFLOW_NODE_HEIGHT,
    position: {
      x: origin.x + node.position.x,
      y: origin.y + node.position.y,
    },
  };
}
