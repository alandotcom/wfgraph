/**
 * The graph the canvas paints for one workspace scope. The overview shows each
 * Group as one collapsed card with its boundary edges on the frame. A focused
 * Group lays its members out from the Group's topology and stored direction,
 * with a stub for each outside port an edge enters or leaves by and for each
 * member port where a path ends. Nothing here writes the graph.
 */

import { sortBy, uniqBy } from "es-toolkit/array";
import {
  analyzeGroupBoundary,
  type GroupPort,
  isGroupNode,
} from "@wfgraph/shared/graph/group-boundary";
import { groupPortKey } from "@wfgraph/shared/graph/group-port-key";
import {
  displayEdgesForGroups,
  groupCanvasPositions,
  groupEndPorts,
  groupLayoutDirection,
} from "@wfgraph/shared/graph/node-group";
import type { GroupLayoutDirection } from "@wfgraph/shared/graph/schemas";
import {
  getConditionBranchDisplayLabel,
  normalizeConditionBranch,
} from "@wfgraph/shared/conditions/condition-branch";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { type NodeChange, Position } from "@xyflow/react";
import type { WorkspaceScope } from "#src/lib/workflow-navigation-state";
import {
  GROUP_BOUNDARY_STUB_PORT,
  type GroupBoundaryStubPort,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import {
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";

export type CanvasGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

export type ScopeCanvasGraph = CanvasGraph & {
  /**
   * The node whose measurement tells the canvas's first placement that React
   * Flow holds the graph. `pinToTop` asks that placement to hold the node near
   * the top of the canvas, which the overview does for its Lifecycle Node.
   */
  anchor: { nodeId: string; pinToTop: boolean } | null;
  /**
   * Nodes painted at a size this module chose. React Flow's measurements of
   * them describe the painting, so the canvas never writes them to the store.
   */
  projectedNodeIds: ReadonlySet<string>;
};

/**
 * The React Flow node types of the boundary stubs: "Incoming from" before the
 * members, and "Continues to" and "Path ends" after them.
 */
export const GROUP_BOUNDARY_NODE_TYPES = {
  ingress: "groupIngress",
  continuation: "groupContinuation",
  end: "groupEnd",
} as const;

/** The height of a boundary stub. Its width is the standard card width. */
export const GROUP_BOUNDARY_STUB_HEIGHT = 40;

/** The words an end stub reads, and the name assistive technology reads for it. */
export const GROUP_END_STUB_LABEL = "Path ends";

type StubDirection = keyof typeof GROUP_BOUNDARY_NODE_TYPES;

/** The stored edges a focused Group paints, by where they sit. */
type EdgeRole = "interior" | "ingress" | "continuation";

const CARD_SIZE = { width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT };

/**
 * Where a focused Group's cards and stubs draw their handles, so edges run along
 * the Group's direction: top to bottom, or left to right.
 */
const HANDLE_POSITIONS: Record<
  GroupLayoutDirection,
  { sourcePosition: Position; targetPosition: Position }
> = {
  vertical: { sourcePosition: Position.Bottom, targetPosition: Position.Top },
  horizontal: { sourcePosition: Position.Right, targetPosition: Position.Left },
};

/**
 * The text every painted id this module makes starts with. The graph schema
 * trims a stored node or edge id when it decodes a graph, so a stored id can
 * never start with a space, and no stub or display-only edge shares an id with
 * a stored node or edge.
 */
const PAINTED_ID_PREFIX = " group-";

/**
 * The id of the stub standing for one port. Two ports never share a port key,
 * so no two ports share a stub id. The id is only a React Flow key; the port
 * itself is read from the stub's data.
 */
export function boundaryStubId(
  direction: StubDirection,
  port: GroupPort
): string {
  return `${PAINTED_ID_PREFIX}${direction}:${groupPortKey(port)}`;
}

/**
 * The port the painted node `nodeId` stands for when it is a boundary stub, or
 * null when it is any other node. A node counts as a stub only when its type is
 * a stub type and its data carries the port.
 */
function stubPortOf(
  nodeId: string | null,
  paintedNodes: readonly WorkflowNode[]
): GroupBoundaryStubPort | null {
  if (nodeId === null) {
    return null;
  }
  const node = paintedNodes.find((item) => item.id === nodeId);
  const stubTypes: readonly (string | undefined)[] = Object.values(
    GROUP_BOUNDARY_NODE_TYPES
  );
  return node && stubTypes.includes(node.type)
    ? (node.data[GROUP_BOUNDARY_STUB_PORT] ?? null)
    : null;
}

/**
 * A painted connection as the store reads it. `fromIngressStub` is true when
 * the painted source was an "Incoming from" stub, whose outside port became the
 * source. `refusal` explains a connection involving a stub that stores nothing.
 */
export type StoredCanvasConnection<C> =
  | { connection: C; fromIngressStub: boolean }
  | { refusal: string };

/**
 * The connection a drag on the painted nodes `paintedNodes` stores. A drag from
 * an ingress stub onto a member names the stub's outside port as its source, so
 * it stores one more edge from the port that already enters the Group. A drag
 * onto a stub, or from a continuation or end stub, is refused. Every other
 * connection comes back as it was given.
 */
export function storedCanvasConnection<
  C extends {
    source: string | null;
    target: string | null;
    sourceHandle?: string | null | undefined;
  },
>(
  connection: C,
  paintedNodes: readonly WorkflowNode[]
): StoredCanvasConnection<C> {
  const source = stubPortOf(connection.source, paintedNodes);
  if (
    stubPortOf(connection.target, paintedNodes) !== null ||
    (source !== null && source.direction !== "ingress")
  ) {
    return { refusal: "Connect to a step inside the Group." };
  }
  if (source === null) {
    return { connection, fromIngressStub: false };
  }
  return {
    connection: {
      ...connection,
      source: source.port.nodeId,
      sourceHandle: source.port.handle,
    },
    fromIngressStub: true,
  };
}

/**
 * One painted copy per stored boundary edge and role, so a recompute that
 * changed nothing hands React Flow the edge objects it already holds.
 */
const paintedBoundaryEdges: Record<
  Exclude<EdgeRole, "interior">,
  WeakMap<WorkflowEdge, WorkflowEdge>
> = {
  ingress: new WeakMap(),
  continuation: new WeakMap(),
};

/**
 * The edge a focused Group paints for a stored edge. An interior edge is the
 * stored edge itself. An ingress edge keeps the stored id, so selecting or
 * deleting it names that one stored edge; its outside end moves onto the stub
 * for its outside port, and it keeps the branch label that port's handle gives
 * it. A continuation edge moves onto its stub and is display only. A stub draws
 * one handle with no id.
 */
function focusedEdge(edge: WorkflowEdge, role: EdgeRole): WorkflowEdge {
  if (role === "interior") {
    return edge;
  }
  const cached = paintedBoundaryEdges[role].get(edge);
  if (cached) {
    return cached;
  }
  let painted: WorkflowEdge;
  if (role === "ingress") {
    const { sourceHandle, ...rest } = edge;
    const displayLabel =
      getConditionBranchDisplayLabel(sourceHandle) ?? edge.data?.displayLabel;
    painted = {
      ...rest,
      source: boundaryStubId("ingress", {
        nodeId: edge.source,
        handle: sourceHandle ?? null,
      }),
      data: omitUndefined({ ...edge.data, displayLabel }),
    };
  } else {
    const { targetHandle, ...rest } = edge;
    painted = {
      ...rest,
      selectable: false,
      deletable: false,
      focusable: false,
      target: boundaryStubId("continuation", {
        nodeId: edge.target,
        handle: targetHandle ?? null,
      }),
    };
  }
  paintedBoundaryEdges[role].set(edge, painted);
  return painted;
}

const collapsedFrames = new WeakMap<WorkflowNode, WorkflowNode>();

/**
 * A frame at the card size the overview draws a collapsed Group at. The copy is
 * cached per frame, so an unchanged frame keeps its identity across repaints.
 */
function collapsedFrame(frame: WorkflowNode): WorkflowNode {
  if (
    frame.width === WORKFLOW_NODE_WIDTH &&
    frame.height === WORKFLOW_NODE_HEIGHT &&
    frame.measured?.width === WORKFLOW_NODE_WIDTH &&
    frame.measured.height === WORKFLOW_NODE_HEIGHT &&
    frame.style?.width === undefined &&
    frame.style?.height === undefined
  ) {
    return frame;
  }
  const cached = collapsedFrames.get(frame);
  if (cached) {
    return cached;
  }
  const { width: _width, height: _height, ...style } = frame.style ?? {};
  const collapsed: WorkflowNode = {
    ...frame,
    ...CARD_SIZE,
    measured: CARD_SIZE,
    style,
  };
  collapsedFrames.set(frame, collapsed);
  return collapsed;
}

/** Whether a node sits inside a Group frame the graph holds. */
function framedBy(
  node: WorkflowNode,
  byId: ReadonlyMap<string, WorkflowNode>
): boolean {
  return node.parentId !== undefined && isGroupNode(byId.get(node.parentId));
}

/**
 * The overview: members hidden, each frame a collapsed card, each boundary edge
 * painted on the frame, and interior edges dropped. Answers the given arrays
 * when the graph holds no Group.
 */
export function overviewCanvasGraph(input: CanvasGraph): ScopeCanvasGraph {
  const lifecycle = input.nodes.find((node) => node.data.type === "lifecycle");
  const anchor = lifecycle ? { nodeId: lifecycle.id, pinToTop: true } : null;
  const frameIds = new Set(
    input.nodes.filter((node) => isGroupNode(node)).map((node) => node.id)
  );
  if (frameIds.size === 0) {
    return { ...input, anchor, projectedNodeIds: frameIds };
  }
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const nodes = input.nodes.flatMap((node) => {
    if (isGroupNode(node)) {
      return [collapsedFrame(node)];
    }
    return framedBy(node, byId) ? [] : [node];
  });
  const shownIds = new Set(nodes.map((node) => node.id));
  const edges = displayEdgesForGroups(input.nodes, input.edges).filter(
    (edge) => shownIds.has(edge.source) && shownIds.has(edge.target)
  );
  return { nodes, edges, anchor, projectedNodeIds: frameIds };
}

const boundaryStubs = new WeakMap<WorkflowNode, Map<string, WorkflowNode>>();

/**
 * End stubs by stub id. An end stub reads nothing from its member but the id,
 * so a member repainted for selection or run status keeps its stub. Each
 * focused compute keeps only the entries it painted.
 */
let endStubs = new Map<string, WorkflowNode>();

/**
 * The stub standing for the port `port` of the step `step`: an outside step for
 * an ingress or continuation stub, which carries that step's label, type and
 * config so the stub can name it, or a member for an end stub, which is
 * labelled "Path ends". A stub never enters the store. An ingress or
 * continuation stub is cached per step, direction and handle, an end stub per
 * stub id in `endStubCache`, and each is kept while its position holds, so React Flow
 * keeps its measured handle.
 */
function boundaryStub(input: {
  direction: StubDirection;
  layout: GroupLayoutDirection;
  step: WorkflowNode;
  port: GroupPort;
  position: { x: number; y: number };
  endStubCache: ReadonlyMap<string, WorkflowNode>;
}): WorkflowNode {
  const { step, position } = input;
  const id = boundaryStubId(input.direction, input.port);
  const stepCache =
    input.direction === "end"
      ? null
      : (boundaryStubs.get(step) ?? new Map<string, WorkflowNode>());
  if (stepCache) {
    boundaryStubs.set(step, stepCache);
  }
  const handles = HANDLE_POSITIONS[input.layout];
  const cached = (stepCache ?? input.endStubCache).get(id);
  if (
    cached?.position.x === position.x &&
    cached.position.y === position.y &&
    cached.sourcePosition === handles.sourcePosition &&
    cached.data.type === step.data.type
  ) {
    return cached;
  }
  const size = {
    width: WORKFLOW_NODE_WIDTH,
    height: GROUP_BOUNDARY_STUB_HEIGHT,
  };
  const stubNames =
    input.direction === "end"
      ? { label: GROUP_END_STUB_LABEL, type: step.data.type }
      : omitUndefined({
          label: step.data.label,
          type: step.data.type,
          config: step.data.config,
        });
  const stub: WorkflowNode = {
    id,
    type: GROUP_BOUNDARY_NODE_TYPES[input.direction],
    position,
    ...handles,
    ...size,
    measured: size,
    selectable: false,
    draggable: false,
    deletable: false,
    focusable: false,
    data: {
      ...stubNames,
      [GROUP_BOUNDARY_STUB_PORT]: {
        direction: input.direction,
        port: input.port,
      },
    },
  };
  // An ingress stub leaves `connectable` unset, so it follows the canvas's
  // `nodesConnectable`, and a drag from it onto a member adds one more edge from
  // the outside port it stands for (see `storedCanvasConnection`). Continuation
  // and end stubs are never connectable.
  if (input.direction !== "ingress") {
    stub.connectable = false;
  }
  stepCache?.set(id, stub);
  return stub;
}

const projectedMembers = new WeakMap<WorkflowNode, WorkflowNode>();

/**
 * A member drawn as a full card with no parent, at `position`, keeping the
 * member's id so a selection or a connection on it names the stored member. It
 * cannot be dragged, because the layout comes from topology and the focused
 * canvas never writes a coordinate back. It leaves `connectable` unset, so it
 * connects to another member exactly when the canvas's `nodesConnectable` allows.
 * The copy is kept while the member, its position and its handle sides hold.
 */
function projectedMember(
  member: WorkflowNode,
  position: { x: number; y: number },
  layout: GroupLayoutDirection
): WorkflowNode {
  const handles = HANDLE_POSITIONS[layout];
  const cached = projectedMembers.get(member);
  if (
    cached?.position.x === position.x &&
    cached.position.y === position.y &&
    cached.sourcePosition === handles.sourcePosition
  ) {
    return cached;
  }
  const {
    parentId: _parentId,
    extent: _extent,
    connectable: _connectable,
    ...rest
  } = member;
  const projected: WorkflowNode = {
    ...rest,
    ...CARD_SIZE,
    ...handles,
    measured: CARD_SIZE,
    draggable: false,
    position,
  };
  projectedMembers.set(member, projected);
  return projected;
}

/**
 * Positions for `count` stubs in one line across the flow, centred on `centre`
 * and sitting at `along` on the flow axis.
 */
function stubLine(
  count: number,
  centre: number,
  along: number,
  direction: GroupLayoutDirection
): { x: number; y: number }[] {
  const pitch =
    direction === "vertical"
      ? WORKFLOW_NODE_WIDTH + NODE_SPACING
      : GROUP_BOUNDARY_STUB_HEIGHT + NODE_SPACING;
  return Array.from({ length: count }, (_, index) => {
    const across = centre + (index - (count - 1) / 2) * pitch;
    return direction === "vertical"
      ? { x: across - WORKFLOW_NODE_WIDTH / 2, y: along }
      : { x: along, y: across - GROUP_BOUNDARY_STUB_HEIGHT / 2 };
  });
}

/**
 * Where a port sits among the outlets of one card: True first, then an unnamed
 * outlet, then False, matching the order a Condition card draws its outlets in.
 */
function outletRank(handle: string | null): number {
  const branch = normalizeConditionBranch(handle);
  return branch === "true" ? 0 : branch === "false" ? 2 : 1;
}

/**
 * End edges by edge id. An end edge reads only its member port, so it is kept
 * across every repaint of that member. Each focused compute keeps only the
 * entries it painted.
 */
let endEdges = new Map<string, WorkflowEdge>();

/**
 * The display-only edge from the member port `port` to its "Path ends" stub,
 * taken from `cache` when it holds one. It keeps the port's handle, so a
 * Condition branch reads True or False on it, and it cannot be selected,
 * deleted or focused.
 */
function endEdge(
  port: GroupPort,
  cache: ReadonlyMap<string, WorkflowEdge>
): WorkflowEdge {
  const id = `${PAINTED_ID_PREFIX}end-edge:${groupPortKey(port)}`;
  return (
    cache.get(id) ?? {
      id,
      source: port.nodeId,
      sourceHandle: port.handle,
      target: boundaryStubId("end", port),
      selectable: false,
      deletable: false,
      focusable: false,
    }
  );
}

/**
 * A focused Group: its members, the interior edges between them, one stub per
 * outside port an edge enters the Group from or continues to, and one "Path
 * ends" stub per member port where a path ends. The frame is not painted, and
 * its stored position and every stored member position are never read. The
 * member rows follow the frame's stored direction. Null when the graph holds no
 * Group `groupId`.
 */
export function focusedGroupCanvasGraph(
  input: CanvasGraph & { groupId: string }
): ScopeCanvasGraph | null {
  const frame = input.nodes.find(
    (node) => node.id === input.groupId && isGroupNode(node)
  );
  if (!frame) {
    return null;
  }
  const direction = groupLayoutDirection(frame);
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const storedMembers = input.nodes.filter(
    (node) => node.parentId === input.groupId
  );
  const boundary = analyzeGroupBoundary({
    memberIds: storedMembers.map((member) => member.id),
    edges: input.edges,
  });
  const positions = groupCanvasPositions({
    memberIds: boundary.memberIds,
    interiorEdges: boundary.interiorEdges,
    direction,
  });
  const members = storedMembers.map((member) =>
    projectedMember(
      member,
      positions.get(member.id) ?? { x: -WORKFLOW_NODE_WIDTH / 2, y: 0 },
      direction
    )
  );
  const firstMember = members[0];
  if (!firstMember) {
    return {
      nodes: [],
      edges: [],
      anchor: null,
      projectedNodeIds: new Set(),
    };
  }

  const vertical = direction === "vertical";
  const starts = members.map((member) =>
    vertical ? member.position.y : member.position.x
  );
  const ends = members.map((member) =>
    vertical
      ? member.position.y + WORKFLOW_NODE_HEIGHT
      : member.position.x + WORKFLOW_NODE_WIDTH
  );
  const acrossCentre = vertical ? 0 : WORKFLOW_NODE_HEIGHT / 2;
  const stubDepth = vertical ? GROUP_BOUNDARY_STUB_HEIGHT : WORKFLOW_NODE_WIDTH;
  const stubs = (
    along: number,
    entries: readonly { direction: StubDirection; port: GroupPort }[]
  ) => {
    const found = entries.flatMap((entry) => {
      const step = byId.get(entry.port.nodeId);
      return step ? [{ ...entry, step }] : [];
    });
    const line = stubLine(found.length, acrossCentre, along, direction);
    return found.map((entry, index) =>
      boundaryStub({
        direction: entry.direction,
        layout: direction,
        step: entry.step,
        port: entry.port,
        position: line[index] ?? { x: 0, y: along },
        endStubCache: endStubs,
      })
    );
  };

  // "Continues to" and "Path ends" stubs share the line after the members,
  // ordered by where the member port each one leaves sits: across the flow
  // first, so their edges cross as little as the line allows, then along the
  // flow, then True before False.
  const projectedById = new Map(members.map((member) => [member.id, member]));
  const centreOf = (port: GroupPort) => {
    const member = projectedById.get(port.nodeId);
    return member
      ? {
          x: member.position.x + WORKFLOW_NODE_WIDTH / 2,
          y: member.position.y + WORKFLOW_NODE_HEIGHT / 2,
        }
      : { x: 0, y: 0 };
  };
  const byFlow = [
    (entry: { from: GroupPort }) =>
      vertical ? centreOf(entry.from).x : centreOf(entry.from).y,
    (entry: { from: GroupPort }) =>
      vertical ? centreOf(entry.from).y : centreOf(entry.from).x,
    (entry: { from: GroupPort }) => outletRank(entry.from.handle),
  ];
  // One "Continues to" stub per outside port, drawn from the member port that
  // comes first in flow order among the edges reaching it.
  const continuations = uniqBy(
    sortBy(
      boundary.continuationEdges.map((edge) => ({
        direction: "continuation" as const,
        port: { nodeId: edge.target, handle: edge.targetHandle ?? null },
        from: { nodeId: edge.source, handle: edge.sourceHandle ?? null },
      })),
      byFlow
    ),
    (entry) => boundaryStubId(entry.direction, entry.port)
  );
  const endPorts = groupEndPorts({ nodes: input.nodes, boundary });
  const afterMembers = sortBy(
    [
      ...continuations,
      ...endPorts.map((port) => ({
        direction: "end" as const,
        port,
        from: port,
      })),
    ],
    byFlow
  );

  const nodes = [
    ...stubs(
      Math.min(...starts) - RANK_SPACING - stubDepth,
      boundary.externalIngress.map((port) => ({
        direction: "ingress" as const,
        port,
      }))
    ),
    ...members,
    ...stubs(Math.max(...ends) + RANK_SPACING, afterMembers),
  ];
  const paintedEndEdges = endPorts.map((port) => endEdge(port, endEdges));
  endStubs = new Map(
    nodes
      .filter((node) => node.type === GROUP_BOUNDARY_NODE_TYPES.end)
      .map((node) => [node.id, node])
  );
  endEdges = new Map(paintedEndEdges.map((item) => [item.id, item]));
  return {
    nodes,
    edges: [
      ...boundary.interiorEdges.map((edge) => focusedEdge(edge, "interior")),
      ...boundary.ingressEdges.map((edge) => focusedEdge(edge, "ingress")),
      ...boundary.continuationEdges.map((edge) =>
        focusedEdge(edge, "continuation")
      ),
      ...paintedEndEdges,
    ],
    anchor: { nodeId: firstMember.id, pinToTop: false },
    projectedNodeIds: new Set(nodes.map((node) => node.id)),
  };
}

/**
 * The graph the canvas paints for `scope`, from the painted nodes and the painted
 * stored edges. A focused Group the graph no longer holds shows the overview
 * until route recovery leaves it.
 */
export function scopeCanvasGraph(
  input: CanvasGraph & { scope: WorkspaceScope }
): ScopeCanvasGraph {
  const graph = { nodes: input.nodes, edges: input.edges };
  if (input.scope.kind === "group") {
    const focused = focusedGroupCanvasGraph({
      ...graph,
      groupId: input.scope.groupId,
    });
    if (focused) {
      return focused;
    }
  }
  return overviewCanvasGraph(graph);
}

/**
 * `changes` without React Flow's measurements of projected nodes. A projected
 * node's size belongs to the painting, so the store never records it. Answers
 * `changes` itself when it holds no such measurement.
 */
export function withoutProjectedDimensions(
  changes: NodeChange<WorkflowNode>[],
  projectedNodeIds: ReadonlySet<string>
): NodeChange<WorkflowNode>[] {
  const kept = changes.filter(
    (change) => change.type !== "dimensions" || !projectedNodeIds.has(change.id)
  );
  return kept.length === changes.length ? changes : kept;
}
