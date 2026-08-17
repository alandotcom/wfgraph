/**
 * Apply and undo a Group on editor nodes: relative positions, compact child
 * size, and React Flow parent constraints. Analysis lives in shared.
 */

import { nanoid } from "nanoid";
import {
  analyzeGroupableSelection,
  isGroupNode,
  type GroupAnalysis,
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

export function groupSelection(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedIds: ReadonlySet<string>;
  createId?: () => string;
}): { nodes: WorkflowNode[]; analysis: GroupAnalysis } | null {
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
  const size = groupFrameSize(members.length);
  const groupId = (input.createId ?? nanoid)();
  const memberSet = new Set(analysis.memberIds);

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
        entryNodeId: analysis.entryId,
        exitNodeId: analysis.exitId,
      },
    },
  };

  const children = members.map((node, index) =>
    nestInGroup(node, groupId, index)
  );
  const rest = input.nodes
    .filter((node) => !memberSet.has(node.id))
    .map((node) => ({ ...node, selected: false }));

  return {
    nodes: [...rest, groupNode, ...children],
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

export function layoutGroupChildren(nodes: WorkflowNode[]): WorkflowNode[] {
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
  for (const [groupId, children] of byParent) {
    const ordered = [...children].toSorted(
      (a, b) => a.position.y - b.position.y
    );
    for (const [index, child] of ordered.entries()) {
      childById.set(child.id, nestInGroup(child, groupId, index));
    }
  }

  return nodes.map((node) => {
    if (isGroupNode(node)) {
      const count = byParent.get(node.id)?.length ?? 0;
      const size = groupFrameSize(count);
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

function nestInGroup(
  node: WorkflowNode,
  groupId: string,
  index: number
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
      x: GROUP_PAD,
      y:
        GROUP_HEADER_HEIGHT +
        GROUP_PAD +
        index * (GROUP_CHILD_HEIGHT + GROUP_CHILD_GAP),
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
