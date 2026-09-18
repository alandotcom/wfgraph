/**
 * Group frames on the editor canvas. Members name their frame through
 * `parentId`, stored edges name members only, and the engine never sees the
 * frame. Display remaps each boundary edge's member end onto the frame, and the
 * frame's inlet and outlet stand for the boundary `group-boundary.ts` derives.
 */

import { groupBy, uniqBy } from "es-toolkit/array";
import {
  getConditionBranchDisplayLabel,
  normalizeConditionBranch,
} from "#src/conditions/condition-branch";
import {
  type GroupContractRule,
  groupRuleBreaks,
  groupStepCount,
} from "#src/graph/group-contract";
import {
  analyzeGroupBoundary,
  analyzeGroupBoundaryById,
  type GroupBoundary,
  type GroupBoundaryEdge,
  type GroupGraphNode,
  type GroupPort,
  isGroupNode,
} from "#src/graph/group-boundary";
import { groupAcrossOffsets } from "#src/graph/group-canvas-lanes";
import { groupPortKey } from "#src/graph/group-port-key";
import { nodeLabel } from "#src/graph/group-structure";
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
 * The members a connection onto the frame's inlet reaches, in member order.
 * Once stored edges enter the Group, those are exactly the members they enter.
 * A Group nothing enters yet is entered at every member no interior edge
 * reaches. Empty when the boundary has no members.
 */
function groupEntryIds(boundary: GroupBoundary<WorkflowEdge>): string[] {
  const entered = new Set(
    boundary.internalEntryPorts.map((port) => port.nodeId)
  );
  if (entered.size > 0) {
    return boundary.memberIds.filter((id) => entered.has(id));
  }
  const reached = new Set(boundary.interiorEdges.map((edge) => edge.target));
  return boundary.memberIds.filter((id) => !reached.has(id));
}

const CONDITION_BRANCHES = ["true", "false"] as const;

/**
 * The member ports where a path ends inside a Group, in member order: each
 * member no stored edge leaves, and each True or False outlet of a Condition
 * member that no stored edge leaves by. A Condition with both outlets
 * unconnected answers both.
 */
export function groupEndPorts(input: {
  nodes: readonly GroupGraphNode[];
  boundary: Pick<
    GroupBoundary<GroupBoundaryEdge>,
    "memberIds" | "interiorEdges" | "continuationEdges"
  >;
}): GroupPort[] {
  // Maps, because node ids are chosen by the builder.
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const leavingBySource = Map.groupBy(
    [...input.boundary.interiorEdges, ...input.boundary.continuationEdges],
    (edge) => edge.source
  );
  return input.boundary.memberIds.flatMap((memberId): GroupPort[] => {
    const leaving = leavingBySource.get(memberId) ?? [];
    if (!isConditionNode(byId.get(memberId))) {
      return leaving.length === 0 ? [{ nodeId: memberId, handle: null }] : [];
    }
    const connected = new Set(
      leaving.map((edge) => normalizeConditionBranch(edge.sourceHandle))
    );
    return CONDITION_BRANCHES.filter((branch) => !connected.has(branch)).map(
      (branch) => ({ nodeId: memberId, handle: branch })
    );
  });
}

/**
 * One source handle a collapsed Group card draws. `handleId` is the React Flow
 * handle id, `ports` are the member ports a connection dragged from the handle
 * stores edges from, and `label` names the outlet, or is null for an unnamed
 * outlet. `continues` is true for an outlet whose edges leave the Group, which
 * name a Condition branch on the edge itself.
 */
export type GroupOutlet = {
  handleId: string | null;
  label: string | null;
  ports: GroupPort[];
  continues: boolean;
};

/**
 * The handle id of the card outlet standing for the end port `port`. Two end
 * ports never share a port key, so they never share a handle id.
 */
function endPortHandleId(port: GroupPort): string {
  return `end:${groupPortKey(port)}`;
}

/**
 * The source handles the collapsed card of the Group `groupId` draws. A Group
 * that continues outside draws one handle per distinct source handle its
 * continuation edges name, with that handle as its id, so every painted edge
 * leaving the card has a handle to attach to. A Group that does not continue
 * draws one handle per end port, labelled with the Condition branch, or with
 * the member's name when the card draws more than one. A Group with neither
 * draws one unlabelled handle standing for no port. `titleOf` names a member.
 * It defaults to the stored label, and the editor passes the title a step's
 * card shows, which falls back to the action's name.
 */
export function groupOutlets<N extends GroupGraphNode>(
  nodes: readonly N[],
  edges: readonly WorkflowEdge[],
  groupId: string,
  titleOf: (node: N) => string = nodeLabel
): GroupOutlet[] {
  const boundary = analyzeGroupBoundaryById({ nodes, edges, groupId });
  if (boundary.internalContinuation.length > 0) {
    // A Map, because an Event Split handle carries a builder-chosen name.
    const byHandle = Map.groupBy(
      boundary.internalContinuation,
      (port) => port.handle
    );
    return [...byHandle].map(([handle, ports]) => ({
      handleId: handle,
      label: getConditionBranchDisplayLabel(handle),
      ports,
      continues: true,
    }));
  }
  const endPorts = groupEndPorts({ nodes, boundary });
  if (endPorts.length === 0) {
    return [{ handleId: null, label: null, ports: [], continues: false }];
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return endPorts.map((port) => {
    const member = byId.get(port.nodeId);
    const memberName = endPorts.length > 1 && member ? titleOf(member) : null;
    return {
      handleId: endPortHandleId(port),
      label: getConditionBranchDisplayLabel(port.handle) ?? memberName,
      ports: [port],
      continues: false,
    };
  });
}

/**
 * The member ports a connection from the card of the Group `groupId` stores
 * edges from, given the handle `handle` it was dragged from: the ports of the
 * outlet with that handle id, else of the first outlet whose port uses that
 * handle, else of the first outlet. Empty for an id that is not a Group.
 */
function groupOutletSources(input: {
  nodes: readonly GroupGraphNode[];
  edges: readonly WorkflowEdge[];
  groupId: string;
  handle: string | null | undefined;
}): GroupPort[] {
  const handle = input.handle ?? null;
  const outlets = groupOutlets(input.nodes, input.edges, input.groupId);
  const chosen =
    outlets.find((outlet) => outlet.handleId === handle) ??
    outlets.find((outlet) =>
      outlet.ports.some((port) => port.handle === handle)
    ) ??
    outlets[0];
  return chosen?.ports ?? [];
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

/** The stored source of one edge a connection adds. */
type StoredSource = {
  source: string;
  sourceHandle: string | null | undefined;
};

/**
 * The stored sources a connection from `sourceId` leaves by. A step answers
 * itself with the handle as given. A Group answers the member ports of the one
 * card outlet `groupOutletSources` picks for `sourceHandle`, each with its own
 * handle, and a Group whose outlet stands for no port answers its own id.
 */
export function resolveStoredSources(input: {
  nodes: readonly GroupGraphNode[];
  edges: readonly WorkflowEdge[];
  sourceId: string;
  sourceHandle: string | null | undefined;
}): StoredSource[] {
  const node = input.nodes.find((item) => item.id === input.sourceId);
  if (!isGroupNode(node)) {
    return [{ source: input.sourceId, sourceHandle: input.sourceHandle }];
  }
  const ports = groupOutletSources({
    nodes: input.nodes,
    edges: input.edges,
    groupId: input.sourceId,
    handle: input.sourceHandle,
  });
  if (ports.length === 0) {
    return [{ source: input.sourceId, sourceHandle: input.sourceHandle }];
  }
  return ports.map((port) => ({
    source: port.nodeId,
    sourceHandle: port.handle ?? undefined,
  }));
}

/**
 * Store edges a connection onto `targetId` would add: a Group inlet fans out
 * onto every entry, and a Group outlet stores from the member ports of the card
 * handle the connection names, which is one port while nothing leaves the
 * Group. Empty means the painted connection already exists. A connection that
 * would enter a Group from a second outside outlet is
 * `addedIngressSourceRefusal`'s to refuse.
 */
export function fanOutStoreEdges(input: {
  nodes: readonly GroupGraphNode[];
  edges: readonly WorkflowEdge[];
  sourceId: string;
  targetId: string;
  sourceHandle: string | null | undefined;
  excludeEdgeId?: string | null;
}): Array<StoredSource & { target: string }> {
  const existing = new Set(
    input.edges
      .filter((edge) => edge.id !== input.excludeEdgeId)
      .map((edge) => `${predecessorKey(edge)}\0${edge.target}`)
  );
  const targets = storedTargetsFor(input.nodes, input.edges, input.targetId);
  return resolveStoredSources(input).flatMap(({ source, sourceHandle }) =>
    targets
      .filter(
        (target) =>
          !existing.has(
            `${predecessorKey({ source, sourceHandle })}\0${target}`
          )
      )
      .map((target) => ({ source, target, sourceHandle }))
  );
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

/** The words each Group layout direction reads as, wherever the editor names one. */
export const GROUP_DIRECTION_LABEL: Readonly<
  Record<GroupLayoutDirection, string>
> = {
  vertical: "Top to bottom",
  horizontal: "Left to right",
};

/**
 * Each member's top-left corner on the focused Group canvas, at the standard
 * card size, keyed by member id. The coordinates belong to the Group alone: a
 * collapsed card at the origin spans x -W/2 to W/2 and y 0 to H, and the first
 * row starts where that card starts. Rows follow interior edges, so a join sits
 * after every predecessor, and `groupAcrossOffsets` keeps a lane clear through
 * each row an edge skips, including an edge from a port in `trailingStubPorts`:
 * the member ports whose edges run to the "Continues to" and "Path ends" stubs
 * after the last row. Only the members, their interior edges, those ports, and
 * `direction` decide it.
 */
export function groupCanvasPositions(input: {
  memberIds: readonly string[];
  interiorEdges: readonly WorkflowEdge[];
  trailingStubPorts?: readonly GroupPort[] | undefined;
  direction?: GroupLayoutDirection | undefined;
}): Map<string, { x: number; y: number }> {
  const slots = groupMemberSlots(input.memberIds, input.interiorEdges);
  const vertical = (input.direction ?? "vertical") === "vertical";
  const rowPitch = vertical
    ? WORKFLOW_NODE_HEIGHT + RANK_SPACING
    : WORKFLOW_NODE_WIDTH + RANK_SPACING;
  const columnPitch = vertical
    ? WORKFLOW_NODE_WIDTH + NODE_SPACING
    : WORKFLOW_NODE_HEIGHT + NODE_SPACING;
  const acrossById = groupAcrossOffsets({
    slots,
    edges: input.interiorEdges,
    trailingStubSourceIds: new Set(
      (input.trailingStubPorts ?? []).map((port) => port.nodeId)
    ),
    pitch: columnPitch,
  });
  return new Map(
    slots.map((slot) => {
      const along = slot.row * rowPitch;
      const across = acrossById.get(slot.id) ?? 0;
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
