/**
 * Group is editor chrome: a visual SESE bundle of lookups plus a Condition.
 * The engine walks the children; edges in the store still name those children.
 * Display remaps the entry's inlet and the exit's True onto the frame.
 */

import { normalizeConditionBranch } from "#src/conditions/condition-branch";
import {
  actionTypeOf,
  isConditionNode,
  isEventSplitActionNode,
  isWaitNode,
  readConfigString,
} from "#src/graph/node-config";
import type { WorkflowEdge } from "#src/graph/types";

/** Node fields grouping reads; shared and editor nodes both satisfy this. */
export type GroupGraphNode = {
  id: string;
  parentId?: string;
  data: {
    type: string;
    label?: string;
    config?: Record<string, unknown>;
  };
};

export function isGroupNode(
  node: { data: { type: string } } | undefined
): boolean {
  return node?.data.type === "group";
}

export function groupEntryId(
  node: GroupGraphNode | undefined
): string | undefined {
  return readConfigString(node?.data.config, "entryNodeId");
}

export function groupExitId(
  node: GroupGraphNode | undefined
): string | undefined {
  return readConfigString(node?.data.config, "exitNodeId");
}

export type GroupAnalysis =
  | {
      ok: true;
      entryId: string;
      exitId: string;
      memberIds: string[];
    }
  | { ok: false; error: string };

/**
 * Whether the selection is a single-entry single-exit chain of lookups and
 * an optional Condition, with Condition False unwired if the exit is one.
 */
export function analyzeGroupableSelection(
  nodes: readonly GroupGraphNode[],
  edges: readonly WorkflowEdge[],
  selectedIds: ReadonlySet<string>
): GroupAnalysis {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const members: GroupGraphNode[] = [];

  for (const id of selectedIds) {
    const node = byId.get(id);
    if (!node) {
      return { ok: false, error: "Select at least two steps" };
    }
    const refused = refuseGroupedMember(node);
    if (refused) {
      return { ok: false, error: refused };
    }
    members.push(node);
  }

  if (members.length < 2) {
    return { ok: false, error: "Select at least two steps" };
  }

  const memberIds = new Set(members.map((node) => node.id));
  const interior = edges.filter(
    (edge) => memberIds.has(edge.source) && memberIds.has(edge.target)
  );

  const incomingFromMembers = new Map<string, number>();
  const outgoingToMembers = new Map<string, number>();
  for (const id of memberIds) {
    incomingFromMembers.set(id, 0);
    outgoingToMembers.set(id, 0);
  }
  for (const edge of interior) {
    incomingFromMembers.set(
      edge.target,
      (incomingFromMembers.get(edge.target) ?? 0) + 1
    );
    outgoingToMembers.set(
      edge.source,
      (outgoingToMembers.get(edge.source) ?? 0) + 1
    );
  }

  const entries = members.filter(
    (node) => (incomingFromMembers.get(node.id) ?? 0) === 0
  );
  const exits = members.filter(
    (node) => (outgoingToMembers.get(node.id) ?? 0) === 0
  );

  if (entries.length !== 1) {
    return { ok: false, error: "Needs exactly one entry step" };
  }
  if (exits.length !== 1) {
    return { ok: false, error: "Needs exactly one exit step" };
  }

  const entry = entries[0];
  const exit = exits[0];
  if (!entry || !exit) {
    return { ok: false, error: "Needs exactly one entry step" };
  }

  for (const edge of edges) {
    const sourceInside = memberIds.has(edge.source);
    const targetInside = memberIds.has(edge.target);
    if (sourceInside === targetInside) {
      continue;
    }

    if (targetInside && edge.target !== entry.id) {
      return { ok: false, error: "Needs exactly one entry step" };
    }
    if (sourceInside && edge.source !== exit.id) {
      return { ok: false, error: "Needs exactly one exit step" };
    }
    if (sourceInside && edge.source === exit.id) {
      const branch = normalizeConditionBranch(edge.sourceHandle);
      if (isConditionNode(exit) && branch === "false") {
        return {
          ok: false,
          error: "Condition False cannot leave the group",
        };
      }
    }
  }

  return {
    ok: true,
    entryId: entry.id,
    exitId: exit.id,
    memberIds: orderMembers(memberIds, interior, entry.id),
  };
}

export function resolveStoredEndpoint(
  nodes: readonly GroupGraphNode[],
  nodeId: string,
  role: "source" | "target"
): string {
  const node = nodes.find((item) => item.id === nodeId);
  if (!isGroupNode(node)) {
    return nodeId;
  }
  const resolved = role === "target" ? groupEntryId(node) : groupExitId(node);
  return resolved ?? nodeId;
}

/**
 * Paint outside→entry as targeting the frame, and exit True→outside as
 * leaving the frame. Store edges still name the children.
 */
export function displayEdgesForGroups<E extends WorkflowEdge>(
  nodes: readonly GroupGraphNode[],
  edges: readonly E[]
): E[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const entryOf = new Map<string, string>();
  const exitOf = new Map<string, string>();

  for (const node of nodes) {
    if (!isGroupNode(node)) {
      continue;
    }
    const entry = groupEntryId(node);
    const exit = groupExitId(node);
    if (entry) {
      entryOf.set(entry, node.id);
    }
    if (exit) {
      exitOf.set(exit, node.id);
    }
  }

  return edges.map((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    let next = edge;

    if (
      source?.parentId &&
      !target?.parentId &&
      exitOf.get(edge.source) === source.parentId
    ) {
      next = { ...next, source: source.parentId };
    }
    if (
      target?.parentId &&
      !source?.parentId &&
      entryOf.get(edge.target) === target.parentId
    ) {
      next = { ...next, target: target.parentId };
    }

    return next;
  });
}

/** Interior edges stay off the outer layout; boundary edges sit on the frame. */
export function edgesForGroupLayout<E extends WorkflowEdge>(
  nodes: readonly GroupGraphNode[],
  edges: readonly E[]
): E[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return displayEdgesForGroups(nodes, edges).filter((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source?.parentId && source.parentId === target?.parentId) {
      return false;
    }
    return !source?.parentId && !target?.parentId;
  });
}

export function expandGroupCopyIds(
  nodes: readonly GroupGraphNode[],
  ids: ReadonlySet<string>
): Set<string> {
  const expanded = new Set(ids);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const id of ids) {
    const node = byId.get(id);
    if (!node) {
      continue;
    }
    if (isGroupNode(node)) {
      for (const child of nodes) {
        if (child.parentId === id) {
          expanded.add(child.id);
        }
      }
      continue;
    }
    if (!node.parentId) {
      continue;
    }
    expanded.add(node.parentId);
    for (const child of nodes) {
      if (child.parentId === node.parentId) {
        expanded.add(child.id);
      }
    }
  }

  return expanded;
}

export function childIdsOfGroup(
  nodes: readonly GroupGraphNode[],
  groupId: string
): string[] {
  return nodes
    .filter((node) => node.parentId === groupId)
    .map((node) => node.id);
}

/** React Flow paints a parent before its children. */
export function orderGroupParentsFirst<T extends GroupGraphNode>(
  nodes: T[]
): T[] {
  if (!nodes.some((node) => isGroupNode(node))) {
    return nodes;
  }

  const groups: T[] = [];
  const children: T[] = [];
  const rest: T[] = [];
  for (const node of nodes) {
    if (isGroupNode(node)) {
      groups.push(node);
    } else if (node.parentId) {
      children.push(node);
    } else {
      rest.push(node);
    }
  }
  return [...rest, ...groups, ...children];
}

export function undersizedGroupIds(nodes: readonly GroupGraphNode[]): string[] {
  const count = new Map<string, number>();
  for (const node of nodes) {
    if (!node.parentId) {
      continue;
    }
    count.set(node.parentId, (count.get(node.parentId) ?? 0) + 1);
  }

  return nodes
    .filter((node) => isGroupNode(node) && (count.get(node.id) ?? 0) < 2)
    .map((node) => node.id);
}

function refuseGroupedMember(node: GroupGraphNode): string | null {
  if (node.data.type === "lifecycle" || node.data.type === "add") {
    return "Only lookup and Condition steps can be grouped";
  }
  if (isGroupNode(node) || node.parentId) {
    return "Already in a group";
  }
  if (node.data.type !== "action") {
    return "Only lookup and Condition steps can be grouped";
  }
  if (!actionTypeOf(node)) {
    return "Every step needs an action";
  }
  if (isWaitNode(node)) {
    return "Wait cannot be grouped";
  }
  if (isEventSplitActionNode(node)) {
    return "Event Split cannot be grouped";
  }
  return null;
}

function orderMembers(
  memberIds: ReadonlySet<string>,
  interior: readonly WorkflowEdge[],
  entryId: string
): string[] {
  const remaining = new Set(memberIds);
  const ordered: string[] = [];
  let current: string | undefined = entryId;

  while (current && remaining.has(current)) {
    ordered.push(current);
    remaining.delete(current);
    const next = interior.find(
      (edge) => edge.source === current && remaining.has(edge.target)
    );
    current = next?.target;
  }

  for (const id of remaining) {
    ordered.push(id);
  }

  return ordered;
}
