/**
 * Group frames on the editor canvas. Members name their frame through
 * `parentId`, stored edges name members only, and the engine never sees the
 * frame. Display remaps each boundary edge's member end onto the frame, and the
 * frame's inlet and outlet stand for the boundary `group-boundary.ts` derives.
 */

import { countBy, groupBy, uniq, uniqBy } from "es-toolkit/array";
import { normalizeConditionBranch } from "#src/conditions/condition-branch";
import {
  type GroupContractRule,
  groupRuleBreaks,
  groupStepCount,
} from "#src/graph/group-contract";
import {
  analyzeGroupBoundary,
  analyzeGroupBoundaryById,
  type GroupBoundary,
  type GroupGraphNode,
  isGroupNode,
} from "#src/graph/group-boundary";
import { isConditionNode } from "#src/graph/node-config";
import {
  type GroupLayoutDirection,
  isGroupLayoutDirection,
} from "#src/graph/schemas";
import type { WorkflowEdge } from "#src/graph/types";
import {
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/graph/workflow-layout-geometry";

/**
 * The members a connection onto the frame's inlet reaches: every member an
 * ingress edge enters, and every member no stored edge enters at all, in member
 * order. Empty when the boundary has no members.
 */
function groupEntryIds(boundary: GroupBoundary<WorkflowEdge>): string[] {
  const entered = new Set(
    boundary.internalEntryPorts.map((port) => port.nodeId)
  );
  const reached = new Set(
    [...boundary.interiorEdges, ...boundary.ingressEdges].map(
      (edge) => edge.target
    )
  );
  return boundary.memberIds.filter((id) => entered.has(id) || !reached.has(id));
}

/**
 * The members a connection from the frame's outlet leaves: the Group's internal
 * continuation when stored edges already leave it, otherwise every member with
 * no outgoing stored edge. Empty when the boundary has no members.
 */
function groupExitIds(boundary: GroupBoundary<WorkflowEdge>): string[] {
  if (boundary.internalContinuation.length > 0) {
    return uniq(boundary.internalContinuation.map((port) => port.nodeId));
  }
  return boundary.terminalMemberIds;
}

/**
 * The distinct source handles of the Group's continuation, in edge order. When
 * nothing leaves the Group yet, one handle: `"true"` when the sole exit member
 * is a Condition, otherwise `null`.
 */
function outletHandlesOf(
  nodes: readonly GroupGraphNode[],
  boundary: GroupBoundary<WorkflowEdge>
): (string | null)[] {
  if (boundary.internalContinuation.length > 0) {
    return uniq(boundary.internalContinuation.map((port) => port.handle));
  }
  const [soleExitId, ...otherExitIds] = boundary.terminalMemberIds;
  const soleExit =
    otherExitIds.length === 0
      ? nodes.find((node) => node.id === soleExitId)
      : undefined;
  return [isConditionNode(soleExit) ? "true" : null];
}

/**
 * The source handle ids a Group frame draws, one per distinct handle its stored
 * continuation edges name, so every painted edge leaving the frame has a handle
 * to attach to. See `outletHandlesOf` for a Group that does not continue yet.
 */
export function groupOutletHandles(
  nodes: readonly GroupGraphNode[],
  edges: readonly WorkflowEdge[],
  groupId: string
): (string | null)[] {
  return outletHandlesOf(
    nodes,
    analyzeGroupBoundaryById({ nodes, edges, groupId })
  );
}

/**
 * The source handle a connection from the frame's outlet is stored with: the
 * first handle `groupOutletHandles` names, undefined where that is `null`.
 * Undefined for an id that is not a Group, because no node names it as a
 * parent and such an id has no continuation and no Condition exit.
 */
export function groupOutletHandle(
  nodes: readonly GroupGraphNode[],
  edges: readonly WorkflowEdge[],
  groupId: string
): string | undefined {
  return groupOutletHandles(nodes, edges, groupId)[0] ?? undefined;
}

export function predecessorKey(edge: {
  source: string;
  sourceHandle?: string | null | undefined;
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

export type GroupMemberSlot = {
  id: string;
  row: number;
  column: number;
};

export type GroupAnalysis =
  | { ok: true; memberIds: string[] }
  | { ok: false; error: string };

/**
 * The short reason a selection cannot be grouped, per Publish rule the would-be
 * Group breaks. The editor shows it beside a disabled Group command, where the
 * full rule message would not fit.
 */
const GROUPING_REFUSALS: Record<GroupContractRule, string> = {
  too_few_members: "Select at least two steps",
  disallowed_member: "Event Split cannot be grouped",
  multiple_ingress_sources: "The steps must be entered from one outlet",
  multiple_continuations: "The steps must continue from one outlet",
  join_crosses_boundary:
    "Every branch into the join must start inside the Group",
  conditional_join_arm: "A Condition on a branch into a join cannot be grouped",
};

/**
 * Whether the selected steps may become one Group, and their order row by row.
 * Every selected node must be a top-level action step. The would-be Group is
 * then held to `groupRuleBreaks`, the rules Publish applies, so any selection
 * the editor groups is a Group that may be published. An Event Split is named
 * first when it is one of the reasons. Grouping
 * changes membership only, so the stored edges it is checked against are the
 * edges the Group keeps.
 */
export function analyzeGroupableSelection(input: {
  nodes: readonly GroupGraphNode[];
  edges: readonly WorkflowEdge[];
  selectedIds: ReadonlySet<string>;
}): GroupAnalysis {
  const selected = input.nodes.filter((node) => input.selectedIds.has(node.id));
  if (selected.length < 2 || selected.length !== input.selectedIds.size) {
    return { ok: false, error: "Select at least two steps" };
  }
  if (selected.some((node) => node.parentId !== undefined)) {
    return { ok: false, error: "Already in a group" };
  }
  if (selected.some((node) => node.data.type !== "action")) {
    return { ok: false, error: "Only steps can be grouped" };
  }

  const ruleBreaks = groupRuleBreaks({
    groupLabel: "Group",
    memberIds: input.selectedIds,
    nodes: input.nodes,
    edges: input.edges,
  });
  const refusal =
    ruleBreaks.find((item) => item.rule === "disallowed_member") ??
    ruleBreaks[0];
  if (refusal) {
    return { ok: false, error: GROUPING_REFUSALS[refusal.rule] };
  }

  const { memberIds, interiorEdges } = analyzeGroupBoundary({
    memberIds: selected.map((node) => node.id),
    edges: input.edges,
  });
  return {
    ok: true,
    memberIds: groupMemberSlots(memberIds, interiorEdges).map(
      (slot) => slot.id
    ),
  };
}

/**
 * The stored sources a connection from `nodeId` leaves: the node itself, or a
 * Group's exit members. A Group with no members answers its own id.
 */
export function resolveStoredSources(
  nodes: readonly GroupGraphNode[],
  edges: readonly WorkflowEdge[],
  nodeId: string
): string[] {
  const node = nodes.find((item) => item.id === nodeId);
  if (!isGroupNode(node)) {
    return [nodeId];
  }
  const exits = groupExitIds(
    analyzeGroupBoundaryById({ nodes, edges, groupId: nodeId })
  );
  return exits.length > 0 ? exits : [nodeId];
}

/**
 * Store edges a connection onto `targetId` would add: a Group inlet fans out
 * onto every entry, and a Group outlet fans out from every exit. A Condition
 * branch handle is stored only on an exit that is a Condition. Empty means the
 * painted connection already exists.
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
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const throughFrame = isGroupNode(byId.get(input.sourceId));
  const branchHandle = normalizeConditionBranch(input.sourceHandle) !== null;
  const targets = storedTargetsFor(input.nodes, input.edges, input.targetId);
  const additions: Array<{
    source: string;
    target: string;
    sourceHandle: string | null | undefined;
  }> = [];
  for (const source of resolveStoredSources(
    input.nodes,
    input.edges,
    input.sourceId
  )) {
    const sourceHandle =
      throughFrame && branchHandle && !isConditionNode(byId.get(source))
        ? undefined
        : input.sourceHandle;
    for (const target of targets) {
      const key = `${predecessorKey({ source, sourceHandle })}\0${target}`;
      if (existing.has(key)) {
        continue;
      }
      additions.push({ source, target, sourceHandle });
    }
  }
  return additions;
}

/**
 * The stored targets a connection onto `nodeId` reaches: the node itself, or a
 * Group's entry members. A Group with no members answers its own id.
 */
export function storedTargetsFor(
  nodes: readonly GroupGraphNode[],
  edges: readonly WorkflowEdge[],
  nodeId: string
): string[] {
  const node = nodes.find((item) => item.id === nodeId);
  if (!isGroupNode(node)) {
    return [nodeId];
  }
  const entries = groupEntryIds(
    analyzeGroupBoundaryById({ nodes, edges, groupId: nodeId })
  );
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
 * Paint each edge entering a Group as targeting its frame, and each edge leaving
 * a Group as leaving its frame. Store edges still name the members. Fan-out onto
 * several entries collapses to one painted edge. Answers the same array when a
 * graph has no frame to paint onto, so the edges take a mutable array.
 */
export function displayEdgesForGroups<E extends WorkflowEdge>(
  nodes: readonly GroupGraphNode[],
  edges: E[]
): E[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentOf = (nodeId: string) => byId.get(nodeId)?.parentId;
  const frameOf = (nodeId: string) => {
    const parentId = parentOf(nodeId);
    return parentId !== undefined && isGroupNode(byId.get(parentId))
      ? parentId
      : undefined;
  };
  let remappedAny = false;

  const remapped = edges.map((edge) => {
    // An edge inside one frame keeps naming its members, which is what marks it
    // interior. Every other end is remapped on its own, because one frame's
    // exit can feed the next frame's entry and neither end is then unframed.
    if (isInteriorEdge(parentOf, edge)) {
      return edge;
    }

    let next = edge;
    const sourceFrame = frameOf(edge.source);
    if (sourceFrame !== undefined) {
      next = { ...next, source: sourceFrame };
    }
    const targetFrame = frameOf(edge.target);
    if (targetFrame !== undefined) {
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

  const byKind = groupBy(nodes, nodeOrderKind);
  return [
    ...(byKind.rest ?? []),
    ...(byKind.groups ?? []),
    ...(byKind.children ?? []),
  ];
}

/** Node kinds in the order `orderGroupParentsFirst` emits them. */
type NodeOrderKind = "rest" | "groups" | "children";

function nodeOrderKind(node: GroupGraphNode): NodeOrderKind {
  return isGroupNode(node) ? "groups" : node.parentId ? "children" : "rest";
}

function isRestGroupsChildrenOrder(nodes: readonly GroupGraphNode[]): boolean {
  let phase: NodeOrderKind = "rest";
  for (const node of nodes) {
    const kind = nodeOrderKind(node);
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

/**
 * The Group frames holding fewer than two steps, counted by `groupStepCount`.
 * Dissolution reads this list and Publish's `too_few_members` rule reads the
 * same count, so the two agree on which Groups are too small.
 */
export function undersizedGroupIds(nodes: readonly GroupGraphNode[]): string[] {
  return nodes
    .filter(
      (node) =>
        isGroupNode(node) && groupStepCount({ groupId: node.id, nodes }) < 2
    )
    .map((node) => node.id);
}

/** Each member's row and column inside its frame, rows following interior edges. */
export function groupMemberSlots(
  memberIds: readonly string[],
  interior: readonly WorkflowEdge[]
): GroupMemberSlot[] {
  const ordered = orderMembers(
    new Set(memberIds),
    interior,
    interiorRootIds(memberIds, interior)
  );
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
  interior: readonly WorkflowEdge[]
): {
  slots: GroupMemberSlot[];
  bounds: { rows: number; columns: number };
} {
  const slots = groupMemberSlots(memberIds, interior);
  return { slots, bounds: groupSlotBounds(slots) };
}

/**
 * The authored layout direction of the Group frame `frame`, stored as
 * `config.direction`. A frame that stores none is laid out vertically.
 */
export function groupLayoutDirection(
  frame: GroupGraphNode | undefined
): GroupLayoutDirection {
  const direction = frame?.data.config?.direction;
  return isGroupLayoutDirection(direction) ? direction : "vertical";
}

/**
 * Each member's top-left corner on the focused Group canvas, at the standard
 * card size, keyed by member id. The coordinates belong to the Group alone: a
 * collapsed card at the origin spans x -W/2 to W/2 and y 0 to H, the first row
 * starts where that card starts, and every row is centred on the card's centre
 * line. Only the members, their interior edges, and `direction` decide it.
 */
export function groupCanvasPositions(input: {
  memberIds: readonly string[];
  interiorEdges: readonly WorkflowEdge[];
  direction?: GroupLayoutDirection | undefined;
}): Map<string, { x: number; y: number }> {
  const slots = groupMemberSlots(input.memberIds, input.interiorEdges);
  const widthOfRow = countBy(slots, (slot) => slot.row);
  const vertical = (input.direction ?? "vertical") === "vertical";
  const rowPitch = vertical
    ? WORKFLOW_NODE_HEIGHT + RANK_SPACING
    : WORKFLOW_NODE_WIDTH + RANK_SPACING;
  const columnPitch = vertical
    ? WORKFLOW_NODE_WIDTH + NODE_SPACING
    : WORKFLOW_NODE_HEIGHT + NODE_SPACING;
  return new Map(
    slots.map((slot) => {
      const rowWidth = widthOfRow[slot.row] ?? 1;
      const along = slot.row * rowPitch;
      const across = (slot.column - (rowWidth - 1) / 2) * columnPitch;
      const position = vertical
        ? { x: across - WORKFLOW_NODE_WIDTH / 2, y: along }
        : { x: along - WORKFLOW_NODE_WIDTH / 2, y: across };
      return [slot.id, position];
    })
  );
}

/** Members no interior edge reaches, in the order `memberIds` lists them. */
function interiorRootIds(
  memberIds: readonly string[],
  interior: readonly WorkflowEdge[]
): string[] {
  const reached = new Set(interior.map((edge) => edge.target));
  return memberIds.filter((id) => !reached.has(id));
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
  const collapsed = uniqBy(edges, edgeEndpointKey);
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
