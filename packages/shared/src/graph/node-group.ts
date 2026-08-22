/**
 * Group is editor chrome: a visual bundle of lookups plus a Condition.
 * The engine walks the children; edges in the store still name those children.
 * Display remaps boundary edges onto one frame inlet and outlet.
 * Lookup exits may share one downstream endpoint; a Condition is one True exit.
 */

import { normalizeConditionBranch } from "#src/conditions/condition-branch";
import { type ExtensionCatalog, findAction } from "#src/extensions/catalog";
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
    enabled?: boolean;
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

export function groupExitIds(node: GroupGraphNode | undefined): string[] {
  const value = node?.data.config?.exitNodeIds;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
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
      exitIds: string[];
      memberIds: string[];
    }
  | { ok: false; error: string };

/**
 * Whether the selection is a bundle of lookups and an optional Condition.
 * Parallel entries share one predecessor. Parallel lookup exits share one
 * downstream endpoint. A Condition remains a single True-only exit.
 */
export function analyzeGroupableSelection(
  nodes: readonly GroupGraphNode[],
  edges: readonly WorkflowEdge[],
  selectedIds: ReadonlySet<string>,
  catalog: ExtensionCatalog
): GroupAnalysis {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const members: GroupGraphNode[] = [];

  for (const id of selectedIds) {
    const node = byId.get(id);
    if (!node) {
      return { ok: false, error: "Select at least two steps" };
    }
    const refused = refuseGroupedMember(node, catalog);
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
  if (exits.length === 0) {
    return { ok: false, error: "Needs an exit step" };
  }

  const entryIds = entries.map((node) => node.id);
  const exitIds = exits.map((node) => node.id);
  const exitIdSet = new Set(exitIds);
  const reachable = reachableFrom(entryIds, interior, memberIds);
  if (reachable.size !== memberIds.size) {
    return { ok: false, error: "Needs a connected lookup group" };
  }
  for (const entryId of entryIds) {
    const entryReachable = reachableFrom([entryId], interior, memberIds);
    if (!exitIds.some((exitId) => entryReachable.has(exitId))) {
      return { ok: false, error: "Needs a connected lookup group" };
    }
  }

  const entryIdSet = new Set(entryIds);
  const incomingKeys = new Set<string>();
  const outgoingEndpoints = new Set<string>();
  const exitsWithOutgoing = new Set<string>();
  for (const edge of edges) {
    const sourceInside = memberIds.has(edge.source);
    const targetInside = memberIds.has(edge.target);
    if (sourceInside === targetInside) {
      continue;
    }

    if (targetInside && !entryIdSet.has(edge.target)) {
      return { ok: false, error: "Needs an entry step" };
    }
    if (sourceInside && !exitIdSet.has(edge.source)) {
      return { ok: false, error: "Only exit steps can leave the group" };
    }
    if (sourceInside && exitIdSet.has(edge.source)) {
      const exit = byId.get(edge.source);
      const branch = normalizeConditionBranch(edge.sourceHandle);
      if (isConditionNode(exit) && branch === "false") {
        return {
          ok: false,
          error: "Condition False cannot leave the group",
        };
      }
      if (isConditionNode(exit) && branch !== "true") {
        return { ok: false, error: "Only Condition True can leave the group" };
      }
      exitsWithOutgoing.add(edge.source);
      outgoingEndpoints.add(`${edge.target}\0${edge.targetHandle ?? ""}`);
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

  if (exitIds.length > 1) {
    if (exits.some((exit) => isConditionNode(exit))) {
      return { ok: false, error: "A Condition must be the only exit step" };
    }
    const exitsAreTerminal = exitsWithOutgoing.size === 0;
    const exitsShareEndpoint =
      exitsWithOutgoing.size === exitIds.length && outgoingEndpoints.size === 1;
    if (!exitsAreTerminal && !exitsShareEndpoint) {
      return {
        ok: false,
        error:
          "Parallel lookup exits must share the same target and target handle",
      };
    }
  }

  return {
    ok: true,
    entryIds,
    exitIds,
    memberIds: orderMembers(memberIds, interior, entryIds),
  };
}

export function resolveStoredSources(
  nodes: readonly GroupGraphNode[],
  nodeId: string
): string[] {
  const node = nodes.find((item) => item.id === nodeId);
  if (!isGroupNode(node)) {
    return [nodeId];
  }
  const exits = groupExitIds(node);
  return exits.length > 0 ? exits : [nodeId];
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
  for (const source of resolveStoredSources(input.nodes, input.sourceId)) {
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
 * Store ids that the painted edge stands for. A frame boundary can collapse
 * several entry or exit edges onto one visible edge.
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
  const displayed = displayEdgeForGroups(nodes, edge);
  const key = edgeEndpointKey(displayed);
  return edges
    .filter(
      (item) => edgeEndpointKey(displayEdgeForGroups(nodes, item)) === key
    )
    .map((item) => item.id);
}

/**
 * Paint outside→entries as targeting the frame, and exit True→outside as
 * leaving the frame. Store edges still name the children. Fan-out onto
 * several entries collapses to one painted edge. Answers the same array when a
 * graph has no frame to paint onto, so the edges take a mutable array.
 */
export function displayEdgesForGroups<E extends WorkflowEdge>(
  nodes: readonly GroupGraphNode[],
  edges: E[]
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
    for (const exit of groupExitIds(node)) {
      exitOf.set(exit, node.id);
    }
  }

  const parentOf = (nodeId: string) => byId.get(nodeId)?.parentId;
  let remappedAny = false;

  const remapped = edges.map((edge) => {
    // An edge inside one frame keeps naming its members, which is what marks it
    // interior. Every other end is remapped on its own, because one frame's
    // exit can feed the next frame's entry and neither end is then unframed.
    if (isInteriorEdge(parentOf, edge)) {
      return edge;
    }

    let next = edge;
    const sourceFrame = parentOf(edge.source);
    if (sourceFrame && exitOf.get(edge.source) === sourceFrame) {
      next = { ...next, source: sourceFrame };
    }
    const targetFrame = parentOf(edge.target);
    if (targetFrame && entryOf.get(edge.target) === targetFrame) {
      next = { ...next, target: targetFrame };
    }
    remappedAny ||= next !== edge;
    return next;
  });

  // `displayEdgesAtom` recomputes on any node change and hands the answer to
  // React Flow as its `edges` prop, which rebuilds the whole connection lookup
  // whenever the array is a new one. A graph with no frame to paint onto would
  // otherwise pay that on every drag frame, so both steps here keep the array
  // they were given when they change nothing in it.
  return collapseDuplicateDisplayEdges(remappedAny ? remapped : edges);
}

/**
 * Interior edges stay off the outer layout; boundary edges sit on the frame.
 * `displayEdgesForGroups` has already moved a boundary edge's inside end onto
 * the frame, and a frame has no parent, so an end that still names a member is
 * what marks an edge as interior.
 */
export function edgesForGroupLayout<E extends WorkflowEdge>(
  nodes: readonly GroupGraphNode[],
  edges: E[]
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

/**
 * The frames that read as disabled, which is every member being disabled.
 *
 * The engine walks members and never sees the frame, so the members hold the
 * fact and the frame's face is read back off them. One pass, because the canvas
 * asks this on every render, including every drag frame.
 */
export function disabledGroupIds(
  nodes: readonly GroupGraphNode[]
): Set<string> {
  const enabledByFrame = new Map<string, boolean>();
  for (const node of nodes) {
    if (!node.parentId) {
      continue;
    }
    const allDisabled =
      (enabledByFrame.get(node.parentId) ?? true) &&
      node.data.enabled === false;
    enabledByFrame.set(node.parentId, allDisabled);
  }

  const disabled = new Set<string>();
  for (const [frameId, allDisabled] of enabledByFrame) {
    if (allDisabled) {
      disabled.add(frameId);
    }
  }
  return disabled;
}

/**
 * React Flow paints a parent before its children, and deletes them the same
 * way: `getElementsToRemove` pulls a child in by searching the nodes it has
 * already collected, so a frame sitting after its members takes none of them
 * with it. Each is then left with a `parentId` naming a node that is gone, and
 * its `extent: "parent"` turns that into a position error and no clamp.
 * Answers the same array when the order already holds, which is what every
 * writer of node state keeps it in.
 */
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

function refuseGroupedMember(
  node: GroupGraphNode,
  catalog: ExtensionCatalog
): string | null {
  if (node.data.type === "lifecycle" || node.data.type === "add") {
    return "Only lookup and Condition steps can be grouped";
  }
  if (isGroupNode(node) || node.parentId) {
    return "Already in a group";
  }
  if (node.data.type !== "action") {
    return "Only lookup and Condition steps can be grouped";
  }
  const actionType = actionTypeOf(node);
  if (!actionType) {
    return "Every step needs an action";
  }
  if (isWaitNode(node)) {
    return "Wait cannot be grouped";
  }
  if (isEventSplitActionNode(node)) {
    return "Event Split cannot be grouped";
  }
  // A group is a bundle a builder pastes again after a Wait so the next send
  // reads a fresh fetch, so a member that moves the outside world would move it
  // again on every paste. An action the catalog does not list declares nothing
  // and is taken at its word.
  if (findAction(catalog, actionType)?.sideEffect) {
    return "A step that changes something outside the workflow stays outside the frame";
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
    const key = edgeEndpointKey(edge);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    collapsed.push(edge);
  }
  // The same array when nothing duplicated, so a canvas render that changed no
  // edge hands React Flow the `edges` prop it already holds.
  return collapsed.length === edges.length ? edges : collapsed;
}

function displayEdgeForGroups<E extends WorkflowEdge>(
  nodes: readonly GroupGraphNode[],
  edge: E
): E {
  return displayEdgesForGroups(nodes, [edge])[0] ?? edge;
}

function edgeEndpointKey(edge: WorkflowEdge): string {
  return `${edge.source}\0${edge.sourceHandle ?? ""}\0${edge.target}\0${edge.targetHandle ?? ""}`;
}
