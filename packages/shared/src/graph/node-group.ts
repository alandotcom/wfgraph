/**
 * Group is editor chrome: a visual SESE bundle of lookups plus a Condition.
 * The engine walks the children; edges in the store still name those children.
 * Display remaps the entries' inlets and the exit's True onto the frame.
 * Interior lookups may sit side by side and AND-join at the exit.
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

export function groupEntryIds(node: GroupGraphNode | undefined): string[] {
  const value = node?.data.config?.entryNodeIds;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
}

export function groupExitId(
  node: GroupGraphNode | undefined
): string | undefined {
  return readConfigString(node?.data.config, "exitNodeId");
}

/** The frame's one source handle; `"true"` when the exit is a Condition. */
export function groupOutletHandle(
  node: GroupGraphNode | undefined
): "true" | undefined {
  return readConfigString(node?.data.config, "outletHandle") === "true"
    ? "true"
    : undefined;
}

export function predecessorKey(edge: {
  source: string;
  sourceHandle?: string | null;
}): string {
  return `${edge.source}\0${edge.sourceHandle ?? ""}`;
}

/**
 * Whether both ends of this edge sit in the same frame. `parentOf` answers for
 * a node id, and a node outside every frame answers undefined, which is why an
 * absent parent is never a match.
 */
export function isInteriorEdge(
  parentOf: (nodeId: string) => string | undefined,
  edge: { source: string; target: string }
): boolean {
  const parent = parentOf(edge.source);
  return parent !== undefined && parent === parentOf(edge.target);
}

/** `isInteriorEdge` against a fixed set of member ids. */
export function isEdgeBetweenMembers(
  memberIds: ReadonlySet<string>,
  edge: { source: string; target: string }
): boolean {
  return memberIds.has(edge.source) && memberIds.has(edge.target);
}

export type GroupMemberSlot = {
  id: string;
  row: number;
  column: number;
};

export type GroupAnalysis =
  | {
      ok: true;
      entryIds: string[];
      exitId: string;
      memberIds: string[];
    }
  | { ok: false; error: string };

/**
 * Whether the selection is a single-exit bundle of lookups and an optional
 * Condition. Several lookups may enter in parallel when they share incoming
 * edges and AND-join at the exit. Condition False stays unwired if the exit
 * is one.
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
  const interior = edges.filter((edge) =>
    isEdgeBetweenMembers(memberIds, edge)
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

  if (entries.length === 0) {
    return { ok: false, error: "Needs an entry step" };
  }
  if (exits.length !== 1) {
    return { ok: false, error: "Needs exactly one exit step" };
  }

  const exit = exits[0];
  if (!exit) {
    return { ok: false, error: "Needs exactly one exit step" };
  }

  const entryIds = entries.map((node) => node.id);
  const reachable = reachableFrom(entryIds, interior, memberIds);
  if (reachable.size !== memberIds.size) {
    return { ok: false, error: "Needs a connected lookup group" };
  }
  for (const entryId of entryIds) {
    if (!reachableFrom([entryId], interior, memberIds).has(exit.id)) {
      return { ok: false, error: "Needs a connected lookup group" };
    }
  }

  const entryIdSet = new Set(entryIds);
  const incomingKeys = new Set<string>();
  for (const edge of edges) {
    const sourceInside = memberIds.has(edge.source);
    const targetInside = memberIds.has(edge.target);
    if (sourceInside === targetInside) {
      continue;
    }

    if (targetInside && !entryIdSet.has(edge.target)) {
      return { ok: false, error: "Needs an entry step" };
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
    if (targetInside && entryIdSet.has(edge.target)) {
      incomingKeys.add(predecessorKey(edge));
    }
  }

  if (incomingKeys.size > 1) {
    return {
      ok: false,
      error: "Parallel lookups must share the same incoming step",
    };
  }

  return {
    ok: true,
    entryIds,
    exitId: exit.id,
    memberIds: orderMembers(memberIds, interior, entryIds),
  };
}

export function resolveStoredSource(
  nodes: readonly GroupGraphNode[],
  nodeId: string
): string {
  const node = nodes.find((item) => item.id === nodeId);
  if (!isGroupNode(node)) {
    return nodeId;
  }
  return groupExitId(node) ?? nodeId;
}

/**
 * Store edges a connection onto `targetId` would add: a Group inlet fans out
 * onto every entry. Empty means the painted connection already exists.
 */
export function fanOutStoreEdges(input: {
  nodes: readonly GroupGraphNode[];
  edges: readonly WorkflowEdge[];
  sourceId: string;
  targetId: string;
  sourceHandle: string | null | undefined;
  excludeEdgeId?: string | null;
}): Array<{
  source: string;
  target: string;
  sourceHandle: string | null | undefined;
}> {
  const source = resolveStoredSource(input.nodes, input.sourceId);
  const existing = new Set(
    input.edges
      .filter((edge) => edge.id !== input.excludeEdgeId)
      .map((edge) => `${predecessorKey(edge)}\0${edge.target}`)
  );
  const additions: Array<{
    source: string;
    target: string;
    sourceHandle: string | null | undefined;
  }> = [];
  for (const target of storedTargetsFor(input.nodes, input.targetId)) {
    const key = `${predecessorKey({ source, sourceHandle: input.sourceHandle })}\0${target}`;
    if (existing.has(key)) {
      continue;
    }
    additions.push({
      source,
      target,
      sourceHandle: input.sourceHandle,
    });
  }
  return additions;
}

export function storedTargetsFor(
  nodes: readonly GroupGraphNode[],
  nodeId: string
): string[] {
  const node = nodes.find((item) => item.id === nodeId);
  if (!isGroupNode(node)) {
    return [nodeId];
  }
  const entries = groupEntryIds(node);
  return entries.length > 0 ? entries : [nodeId];
}

/**
 * Store ids that the painted edge stands for: a collapsed fan-out into a
 * Group is every edge from that source onto the frame's entries.
 */
export function fanOutStoreEdgeIds(
  nodes: readonly GroupGraphNode[],
  edges: readonly WorkflowEdge[],
  edgeId: string
): string[] {
  const edge = edges.find((item) => item.id === edgeId);
  if (!edge) {
    return [];
  }
  const target = nodes.find((node) => node.id === edge.target);
  const group = target?.parentId
    ? nodes.find((node) => node.id === target.parentId)
    : undefined;
  if (!isGroupNode(group)) {
    return [edgeId];
  }
  const entries = new Set(groupEntryIds(group));
  if (!entries.has(edge.target)) {
    return [edgeId];
  }
  return edges
    .filter(
      (item) =>
        item.source === edge.source &&
        (item.sourceHandle ?? "") === (edge.sourceHandle ?? "") &&
        entries.has(item.target)
    )
    .map((item) => item.id);
}

/**
 * Paint outside→entries as targeting the frame, and exit True→outside as
 * leaving the frame. Store edges still name the children. Fan-out onto
 * several entries collapses to one painted edge.
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
    for (const entry of groupEntryIds(node)) {
      entryOf.set(entry, node.id);
    }
    const exit = groupExitId(node);
    if (exit) {
      exitOf.set(exit, node.id);
    }
  }

  const remapped = edges.map((edge) => {
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

  return collapseDuplicateDisplayEdges(remapped);
}

/**
 * Interior edges stay off the outer layout; boundary edges sit on the frame.
 * `displayEdgesForGroups` has already moved a boundary edge's inside end onto
 * the frame, and a frame has no parent, so an end that still names a member is
 * what marks an edge as interior.
 */
export function edgesForGroupLayout<E extends WorkflowEdge>(
  nodes: readonly GroupGraphNode[],
  edges: readonly E[]
): E[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return displayEdgesForGroups(nodes, edges).filter(
    (edge) =>
      !byId.get(edge.source)?.parentId && !byId.get(edge.target)?.parentId
  );
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

  if (isRestGroupsChildrenOrder(nodes)) {
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

function isRestGroupsChildrenOrder(nodes: readonly GroupGraphNode[]): boolean {
  let phase: "rest" | "groups" | "children" = "rest";
  for (const node of nodes) {
    const kind: "rest" | "groups" | "children" = isGroupNode(node)
      ? "groups"
      : node.parentId
        ? "children"
        : "rest";
    if (kind === phase) {
      continue;
    }
    if (phase === "rest" && kind === "groups") {
      phase = "groups";
      continue;
    }
    if (phase === "groups" && kind === "children") {
      phase = "children";
      continue;
    }
    return false;
  }
  return true;
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

export function groupMemberSlots(
  memberIds: readonly string[],
  interior: readonly WorkflowEdge[],
  entryIds: readonly string[]
): GroupMemberSlot[] {
  const ordered = orderMembers(new Set(memberIds), interior, entryIds);
  const preds = new Map<string, string[]>();
  for (const id of memberIds) {
    preds.set(id, []);
  }
  for (const edge of interior) {
    preds.get(edge.target)?.push(edge.source);
  }

  const rank = new Map<string, number>();
  for (const id of ordered) {
    const parentRanks = (preds.get(id) ?? [])
      .filter((predecessor) => rank.has(predecessor))
      .map((predecessor) => rank.get(predecessor) ?? 0);
    rank.set(id, parentRanks.length === 0 ? 0 : Math.max(...parentRanks) + 1);
  }

  const columnsByRow = new Map<number, number>();
  return ordered.map((id) => {
    const row = rank.get(id) ?? 0;
    const column = columnsByRow.get(row) ?? 0;
    columnsByRow.set(row, column + 1);
    return { id, row, column };
  });
}

export function groupSlotBounds(slots: readonly GroupMemberSlot[]): {
  rows: number;
  columns: number;
} {
  if (slots.length === 0) {
    return { rows: 1, columns: 1 };
  }
  return {
    rows: Math.max(...slots.map((slot) => slot.row + 1)),
    columns: Math.max(...slots.map((slot) => slot.column + 1)),
  };
}

export function groupInteriorLayout(
  memberIds: readonly string[],
  interior: readonly WorkflowEdge[],
  entryIds: readonly string[]
): {
  slots: GroupMemberSlot[];
  bounds: { rows: number; columns: number };
} {
  const slots = groupMemberSlots(memberIds, interior, entryIds);
  return { slots, bounds: groupSlotBounds(slots) };
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

function reachableFrom(
  starts: readonly string[],
  interior: readonly WorkflowEdge[],
  memberIds: ReadonlySet<string>
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of interior) {
    const next = outgoing.get(edge.source) ?? [];
    next.push(edge.target);
    outgoing.set(edge.source, next);
  }

  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id) || !memberIds.has(id)) {
      continue;
    }
    seen.add(id);
    for (const next of outgoing.get(id) ?? []) {
      stack.push(next);
    }
  }
  return seen;
}

function orderMembers(
  memberIds: ReadonlySet<string>,
  interior: readonly WorkflowEdge[],
  entryIds: readonly string[]
): string[] {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of memberIds) {
    indegree.set(id, 0);
    outgoing.set(id, []);
  }
  for (const edge of interior) {
    if (!memberIds.has(edge.source) || !memberIds.has(edge.target)) {
      continue;
    }
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const queue = entryIds.filter((id) => memberIds.has(id));
  const ordered: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    ordered.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const nextDegree = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  for (const id of memberIds) {
    if (!seen.has(id)) {
      ordered.push(id);
    }
  }

  return ordered;
}

function collapseDuplicateDisplayEdges<E extends WorkflowEdge>(
  edges: E[]
): E[] {
  const seen = new Set<string>();
  const collapsed: E[] = [];
  for (const edge of edges) {
    const key = `${edge.source}\0${edge.sourceHandle ?? ""}\0${edge.target}\0${edge.targetHandle ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    collapsed.push(edge);
  }
  return collapsed;
}
