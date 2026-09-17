/**
 * Group frames on the editor canvas. Members name their frame through
 * `parentId`, stored edges name members only, and the engine never sees the
 * frame. Display remaps each boundary edge's member end onto the frame, and the
 * frame's inlet and outlet stand for the boundary `group-boundary.ts` derives.
 */

import { groupBy } from "es-toolkit/array";
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
  analyzeGroupBoundaryById,
  type GroupBoundary,
  type GroupBoundaryEdge,
  type GroupGraphNode,
  type GroupPort,
  isGroupNode,
} from "#src/graph/group-boundary";
import { isConditionNode } from "#src/graph/node-config";
import type { WorkflowEdge } from "#src/graph/types";

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
 * What the one bottom outlet of a collapsed Group card stands for. `ports` are
 * the member ports a connection dragged from the outlet stores edges from.
 * `continues` is true when those are the ports the Group's stored edges already
 * leave it by.
 */
export type GroupOutlet = {
  ports: GroupPort[];
  continues: boolean;
};

/**
 * The outlet of the collapsed card of the Group `groupId`. A Group that
 * continues outside stands for the member ports its continuation edges leave
 * by, so a connection from the card reaches its new step from those same
 * ports. A Group that does not continue stands for every end port, so a step
 * connected from the card runs once after every path inside the Group
 * finishes. A Group with neither, or an id that is not a Group, stands for no
 * port.
 */
export function groupOutlet(
  nodes: readonly GroupGraphNode[],
  edges: readonly WorkflowEdge[],
  groupId: string
): GroupOutlet {
  const boundary = analyzeGroupBoundaryById({ nodes, edges, groupId });
  if (boundary.internalContinuation.length > 0) {
    return { ports: boundary.internalContinuation, continues: true };
  }
  return { ports: groupEndPorts({ nodes, boundary }), continues: false };
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
  multiple_continuations: "The steps must continue to one outside step",
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

  return { ok: true, memberIds: selected.map((node) => node.id) };
}

/** The stored source of one edge a connection adds. */
type StoredSource = {
  source: string;
  sourceHandle: string | null | undefined;
};

/**
 * The stored sources a connection from `sourceId` leaves by. A step answers
 * itself with the handle as given. A Group answers the member ports its one
 * card outlet stands for (see `groupOutlet`), each with its own handle, and a
 * Group whose outlet stands for no port answers its own id.
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
  const { ports } = groupOutlet(input.nodes, input.edges, input.sourceId);
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
 * onto every entry, and a Group outlet stores from every member port the card
 * outlet stands for. Empty means the painted connection already exists. A
 * connection that would enter a Group from a second outside outlet is
 * `addedIngressSourceRefusal`'s to refuse, and one that would leave a Group
 * several ways is `addedContinuationRefusal`'s.
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
 * a Group as leaving the frame's one outlet, which has no handle id. An edge
 * leaving by a Condition branch carries that branch's name in
 * `data.displayLabel`. Store edges still name the members. Edges that paint
 * with the same ends collapse to one painted edge, such as a fan-out onto
 * several entries or several members continuing to one step, and the painted
 * edge keeps a label only when every edge it stands for has that label.
 * Answers the same array when a graph has no frame to paint onto, so the edges
 * take a mutable array.
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
      const branch = getConditionBranchDisplayLabel(edge.sourceHandle);
      next = { ...next, source: sourceFrame, sourceHandle: null };
      if (branch !== null) {
        next = { ...next, data: { ...next.data, displayLabel: branch } };
      }
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

function collapseDuplicateDisplayEdges<E extends WorkflowEdge>(
  edges: E[]
): E[] {
  // A Map, because the key holds builder-chosen node ids.
  const byEnds = Map.groupBy(edges, edgeEndpointKey);
  // The same array when nothing duplicated, so a canvas render that changed no
  // edge hands React Flow the `edges` prop it already holds.
  if (byEnds.size === edges.length) {
    return edges;
  }
  return [...byEnds.values()].flatMap(([first, ...rest]) => {
    if (first === undefined) {
      return [];
    }
    const label = first.data?.displayLabel;
    if (
      label === undefined ||
      rest.every((edge) => edge.data?.displayLabel === label)
    ) {
      return [first];
    }
    const { displayLabel: _displayLabel, ...data } = first.data ?? {};
    return [{ ...first, data }];
  });
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
