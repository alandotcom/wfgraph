/**
 * The graph the canvas paints for one workspace scope. The overview shows each
 * Group as one collapsed card with its boundary edges on the frame. A focused
 * Group lays its members out from the Group's topology alone, with a stub for
 * each outside port an edge enters or leaves by. Nothing here writes the graph.
 */

import {
  analyzeGroupBoundary,
  type GroupPort,
  isGroupNode,
} from "@wfgraph/shared/graph/group-boundary";
import {
  displayEdgesForGroups,
  groupCanvasPositions,
  type GroupLayoutDirection,
} from "@wfgraph/shared/graph/node-group";
import { getConditionBranchDisplayLabel } from "@wfgraph/shared/conditions/condition-branch";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import type { NodeChange } from "@xyflow/react";
import type { WorkspaceScope } from "#src/lib/workflow-navigation-state";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
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

/** The React Flow node types of the two boundary stubs. */
export const GROUP_BOUNDARY_NODE_TYPES = {
  ingress: "groupIngress",
  continuation: "groupContinuation",
} as const;

/** The height of a boundary stub. Its width is the standard card width. */
export const GROUP_BOUNDARY_STUB_HEIGHT = 40;

type StubDirection = keyof typeof GROUP_BOUNDARY_NODE_TYPES;

type EdgeRole = "interior" | StubDirection;

const CARD_SIZE = { width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT };

/**
 * The id of the stub standing for one outside port: the encoded node id, then a
 * slash and the encoded handle when the port has one. An encoded id holds no
 * slash, so no two ports share a stub id.
 */
export function boundaryStubId(
  direction: StubDirection,
  port: GroupPort
): string {
  const nodeId = encodeURIComponent(port.nodeId);
  return port.handle === null
    ? `group-${direction}:${nodeId}`
    : `group-${direction}:${nodeId}/${encodeURIComponent(port.handle)}`;
}

/**
 * One display-only copy per stored edge and role, so a recompute that changed
 * nothing hands React Flow the edge objects it already holds.
 */
const displayOnlyEdges: Record<
  EdgeRole,
  WeakMap<WorkflowEdge, WorkflowEdge>
> = {
  interior: new WeakMap(),
  ingress: new WeakMap(),
  continuation: new WeakMap(),
};

/**
 * The edge a focused Group paints for a stored edge. Every one is display only.
 * A boundary edge's outside end moves onto the stub for its outside port, which
 * draws one handle with no id. An ingress edge keeps the branch label its
 * outside source handle gave it.
 */
function focusedEdge(edge: WorkflowEdge, role: EdgeRole): WorkflowEdge {
  const cached = displayOnlyEdges[role].get(edge);
  if (cached) {
    return cached;
  }
  const locked = {
    ...edge,
    selectable: false,
    deletable: false,
    focusable: false,
  };
  let painted: WorkflowEdge = locked;
  if (role === "ingress") {
    const { sourceHandle, ...rest } = locked;
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
  } else if (role === "continuation") {
    const { targetHandle, ...rest } = locked;
    painted = {
      ...rest,
      target: boundaryStubId("continuation", {
        nodeId: edge.target,
        handle: targetHandle ?? null,
      }),
    };
  }
  displayOnlyEdges[role].set(edge, painted);
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
 * The stub standing for the outside port `port` of the step `outside`. It carries
 * that step's label, type and config so the stub can name it, and it never
 * enters the store. A stub is cached per outside node, direction and handle, and
 * kept while its position holds, so React Flow keeps its measured handle.
 */
function boundaryStub(input: {
  direction: StubDirection;
  outside: WorkflowNode;
  port: GroupPort;
  position: { x: number; y: number };
}): WorkflowNode {
  const { outside, position } = input;
  const id = boundaryStubId(input.direction, input.port);
  const cache = boundaryStubs.get(outside) ?? new Map<string, WorkflowNode>();
  boundaryStubs.set(outside, cache);
  const cached = cache.get(id);
  if (cached?.position.x === position.x && cached.position.y === position.y) {
    return cached;
  }
  const size = {
    width: WORKFLOW_NODE_WIDTH,
    height: GROUP_BOUNDARY_STUB_HEIGHT,
  };
  const stub: WorkflowNode = {
    id,
    type: GROUP_BOUNDARY_NODE_TYPES[input.direction],
    position,
    ...size,
    measured: size,
    selectable: false,
    draggable: false,
    connectable: false,
    deletable: false,
    focusable: false,
    data: omitUndefined({
      label: outside.data.label,
      type: outside.data.type,
      config: outside.data.config,
    }),
  };
  cache.set(id, stub);
  return stub;
}

const projectedMembers = new WeakMap<WorkflowNode, WorkflowNode>();

/**
 * A member drawn as a full card with no parent, at `position`. It cannot be
 * dragged or connected, because the focused canvas never writes a coordinate or
 * an edge back. The copy is kept while the member and its position hold.
 */
function projectedMember(
  member: WorkflowNode,
  position: { x: number; y: number }
): WorkflowNode {
  const cached = projectedMembers.get(member);
  if (cached?.position.x === position.x && cached.position.y === position.y) {
    return cached;
  }
  const { parentId: _parentId, extent: _extent, ...rest } = member;
  const projected: WorkflowNode = {
    ...rest,
    ...CARD_SIZE,
    measured: CARD_SIZE,
    draggable: false,
    connectable: false,
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
 * A focused Group: its members, the interior edges between them, and one stub
 * per outside port an edge enters the Group from or continues to. The frame is
 * not painted, and its stored position and every stored member position are
 * never read. `direction` is the axis the member rows follow. Null when the
 * graph holds no Group `groupId`.
 */
export function focusedGroupCanvasGraph(
  input: CanvasGraph & {
    groupId: string;
    direction?: GroupLayoutDirection | undefined;
  }
): ScopeCanvasGraph | null {
  const direction = input.direction ?? "vertical";
  const frame = input.nodes.find(
    (node) => node.id === input.groupId && isGroupNode(node)
  );
  if (!frame) {
    return null;
  }
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
      positions.get(member.id) ?? { x: -WORKFLOW_NODE_WIDTH / 2, y: 0 }
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
  const stubs = (stubDirection: StubDirection, ports: readonly GroupPort[]) => {
    const outside = ports.flatMap((port) => {
      const node = byId.get(port.nodeId);
      return node ? [{ node, port }] : [];
    });
    const along =
      stubDirection === "ingress"
        ? Math.min(...starts) - RANK_SPACING - stubDepth
        : Math.max(...ends) + RANK_SPACING;
    const line = stubLine(outside.length, acrossCentre, along, direction);
    return outside.map(({ node, port }, index) =>
      boundaryStub({
        direction: stubDirection,
        outside: node,
        port,
        position: line[index] ?? { x: 0, y: along },
      })
    );
  };

  const nodes = [
    ...stubs("ingress", boundary.externalIngress),
    ...members,
    ...stubs("continuation", boundary.externalTargets),
  ];
  return {
    nodes,
    edges: [
      ...boundary.interiorEdges.map((edge) => focusedEdge(edge, "interior")),
      ...boundary.ingressEdges.map((edge) => focusedEdge(edge, "ingress")),
      ...boundary.continuationEdges.map((edge) =>
        focusedEdge(edge, "continuation")
      ),
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
