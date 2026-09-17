/**
 * The overview paints collapsed Groups. A focused Group paints members at their
 * stored, frame-relative positions and derives boundary stubs from those cards.
 * Projection never writes positions; dragging, adding steps and Tidy own them.
 */
import { omit } from "es-toolkit/object";
import { sortBy } from "es-toolkit/array";
import {
  analyzeGroupBoundary,
  type GroupPort,
  isGroupNode,
} from "@wfgraph/shared/graph/group-boundary";
import { groupPortKey } from "@wfgraph/shared/graph/group-port-key";
import {
  displayEdgesForGroups,
  groupEndPorts,
} from "@wfgraph/shared/graph/node-group";
import { getConditionBranchDisplayLabel } from "@wfgraph/shared/conditions/condition-branch";
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
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";

export type CanvasGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
export type ScopeCanvasGraph = CanvasGraph & {
  anchor: { nodeId: string; pinToTop: boolean } | null;
  /** Only painted frames and stubs have measurements that must not be stored. */
  projectedNodeIds: ReadonlySet<string>;
};

export const GROUP_BOUNDARY_NODE_TYPES = {
  ingress: "groupIngress",
  continuation: "groupContinuation",
  end: "groupEnd",
} as const;
export const GROUP_BOUNDARY_STUB_HEIGHT = 40;
export const GROUP_END_STUB_LABEL = "Path ends";
type StubDirection = keyof typeof GROUP_BOUNDARY_NODE_TYPES;
type EdgeRole = "interior" | "ingress" | "continuation";
const CARD_SIZE = { width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT };
const HANDLES = {
  sourcePosition: Position.Bottom,
  targetPosition: Position.Top,
};
// Stored ids are trimmed by the schema, so this prefix cannot collide with one.
const PAINTED_ID_PREFIX = " group-";

export function boundaryStubId(
  direction: StubDirection,
  port: GroupPort
): string {
  return `${PAINTED_ID_PREFIX}${direction}:${groupPortKey(port)}`;
}

function stubPortOf(
  nodeId: string | null,
  paintedNodes: readonly WorkflowNode[]
): GroupBoundaryStubPort | null {
  const node = paintedNodes.find((item) => item.id === nodeId);
  const stubTypes: readonly (string | undefined)[] = Object.values(
    GROUP_BOUNDARY_NODE_TYPES
  );
  return node && stubTypes.includes(node.type)
    ? (node.data[GROUP_BOUNDARY_STUB_PORT] ?? null)
    : null;
}

export type StoredCanvasConnection<C> =
  | { connection: C; throughBoundaryStub: boolean }
  | { refusal: string };

/** Translate a stub into its stored port, refusing connections between stubs. */
export function storedCanvasConnection<
  C extends {
    source: string | null;
    target: string | null;
    sourceHandle?: string | null | undefined;
    targetHandle?: string | null | undefined;
  },
>(
  connection: C,
  paintedNodes: readonly WorkflowNode[]
): StoredCanvasConnection<C> {
  const source = stubPortOf(connection.source, paintedNodes);
  const target = stubPortOf(connection.target, paintedNodes);
  if (
    (source !== null && target !== null) ||
    (source !== null && source.direction !== "ingress") ||
    (target !== null && target.direction !== "continuation")
  ) {
    return { refusal: "Connect to a step inside the Group." };
  }
  if (source !== null) {
    return {
      connection: {
        ...connection,
        source: source.port.nodeId,
        sourceHandle: source.port.handle,
      },
      throughBoundaryStub: true,
    };
  }
  if (target !== null) {
    return {
      connection: {
        ...connection,
        target: target.port.nodeId,
        targetHandle: target.port.handle,
      },
      throughBoundaryStub: true,
    };
  }
  return { connection, throughBoundaryStub: false };
}

const paintedBoundaryEdges: Record<
  Exclude<EdgeRole, "interior">,
  WeakMap<WorkflowEdge, WorkflowEdge>
> = {
  ingress: new WeakMap(),
  continuation: new WeakMap(),
};

/** Boundary edges retain their stored ids, so selection and deletion stay exact. */
function focusedEdge(edge: WorkflowEdge, role: EdgeRole): WorkflowEdge {
  if (role === "interior") return edge;
  const cached = paintedBoundaryEdges[role].get(edge);
  if (cached) return cached;
  const painted: WorkflowEdge =
    role === "ingress"
      ? {
          ...omit(edge, ["sourceHandle"]),
          source: boundaryStubId("ingress", {
            nodeId: edge.source,
            handle: edge.sourceHandle ?? null,
          }),
          data: omitUndefined({
            ...edge.data,
            displayLabel:
              getConditionBranchDisplayLabel(edge.sourceHandle) ??
              edge.data?.displayLabel,
          }),
        }
      : {
          ...omit(edge, ["targetHandle"]),
          target: boundaryStubId("continuation", {
            nodeId: edge.target,
            handle: edge.targetHandle ?? null,
          }),
        };
  paintedBoundaryEdges[role].set(edge, painted);
  return painted;
}

const collapsedFrames = new WeakMap<WorkflowNode, WorkflowNode>();
function collapsedFrame(frame: WorkflowNode): WorkflowNode {
  const cached = collapsedFrames.get(frame);
  if (cached) return cached;
  const collapsed: WorkflowNode = {
    ...frame,
    ...CARD_SIZE,
    measured: CARD_SIZE,
    style: omit(frame.style ?? {}, ["width", "height"]),
  };
  collapsedFrames.set(frame, collapsed);
  return collapsed;
}

export function overviewCanvasGraph(input: CanvasGraph): ScopeCanvasGraph {
  const lifecycle = input.nodes.find((node) => node.data.type === "lifecycle");
  const anchor = lifecycle ? { nodeId: lifecycle.id, pinToTop: true } : null;
  const frameIds = new Set(
    input.nodes.filter(isGroupNode).map((node) => node.id)
  );
  if (frameIds.size === 0)
    return { ...input, anchor, projectedNodeIds: frameIds };
  const nodes = input.nodes.flatMap((node) => {
    if (isGroupNode(node)) return [collapsedFrame(node)];
    return node.parentId !== undefined && frameIds.has(node.parentId)
      ? []
      : [node];
  });
  const shownIds = new Set(nodes.map((node) => node.id));
  const edges = displayEdgesForGroups(input.nodes, input.edges).filter(
    (edge) => shownIds.has(edge.source) && shownIds.has(edge.target)
  );
  return { nodes, edges, anchor, projectedNodeIds: frameIds };
}

const boundaryStubs = new WeakMap<WorkflowNode, Map<string, WorkflowNode>>();
let endStubs = new Map<string, WorkflowNode>();
function boundaryStub(input: {
  direction: StubDirection;
  step: WorkflowNode;
  port: GroupPort;
  position: { x: number; y: number };
}): WorkflowNode {
  const { step, position } = input;
  const id = boundaryStubId(input.direction, input.port);
  const cache =
    input.direction === "end"
      ? endStubs
      : (boundaryStubs.get(step) ?? new Map<string, WorkflowNode>());
  if (input.direction !== "end") boundaryStubs.set(step, cache);
  const cached = cache.get(id);
  if (
    cached?.position.x === position.x &&
    cached.position.y === position.y &&
    cached.data.type === step.data.type
  )
    return cached;
  const size = {
    width: WORKFLOW_NODE_WIDTH,
    height: GROUP_BOUNDARY_STUB_HEIGHT,
  };
  const names =
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
    ...HANDLES,
    ...size,
    measured: size,
    selectable: false,
    draggable: false,
    deletable: false,
    focusable: false,
    data: {
      ...names,
      [GROUP_BOUNDARY_STUB_PORT]: {
        direction: input.direction,
        port: input.port,
      },
    },
  };
  if (input.direction === "end") stub.connectable = false;
  cache.set(id, stub);
  return stub;
}

const projectedMembers = new WeakMap<WorkflowNode, WorkflowNode>();
/** Removing the frame changes no coordinate: stored member positions are local. */
function projectedMember(member: WorkflowNode): WorkflowNode {
  const cached = projectedMembers.get(member);
  if (cached) return cached;
  const projected: WorkflowNode = {
    ...omit(member, [
      "parentId",
      "extent",
      "expandParent",
      "connectable",
      "draggable",
    ]),
    width: member.width ?? WORKFLOW_NODE_WIDTH,
    height: member.height ?? WORKFLOW_NODE_HEIGHT,
    measured: member.measured ?? CARD_SIZE,
    ...HANDLES,
  };
  projectedMembers.set(member, projected);
  return projected;
}

let endEdges = new Map<string, WorkflowEdge>();
function endEdge(port: GroupPort): WorkflowEdge {
  const id = `${PAINTED_ID_PREFIX}end-edge:${groupPortKey(port)}`;
  return (
    endEdges.get(id) ?? {
      id,
      source: port.nodeId,
      sourceHandle: port.handle,
      target: boundaryStubId("end", port),
      selectable: false,
      deletable: false,
      focusable: false,
      data: { insertable: false },
    }
  );
}

function workflowNodeDimensions(node: WorkflowNode) {
  return {
    width: node.measured?.width ?? node.width ?? WORKFLOW_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? WORKFLOW_NODE_HEIGHT,
  };
}

/** Centre a stub on the cards it meets, one rank above or below those cards. */
function stubPosition(
  cards: readonly WorkflowNode[],
  direction: StubDirection
): { x: number; y: number } {
  const left = Math.min(...cards.map((node) => node.position.x));
  const right = Math.max(
    ...cards.map((node) => node.position.x + workflowNodeDimensions(node).width)
  );
  return {
    x: (left + right - WORKFLOW_NODE_WIDTH) / 2,
    y:
      direction === "ingress"
        ? Math.min(...cards.map((node) => node.position.y)) -
          RANK_SPACING -
          GROUP_BOUNDARY_STUB_HEIGHT
        : Math.max(
            ...cards.map(
              (node) => node.position.y + workflowNodeDimensions(node).height
            )
          ) + RANK_SPACING,
  };
}

const separatedStubs = new WeakMap<WorkflowNode, WorkflowNode>();
/** Separate vertically overlapping stubs horizontally, keeping each band's centre. */
function separateBoundaryStubs(
  stubs: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowNode[] {
  const gap = 24;
  const edgesByTarget = Map.groupBy(edges, (edge) => edge.target);
  const branchOrder = (stub: WorkflowNode) => {
    const incoming = edgesByTarget.get(stub.id);
    const handle = incoming?.length === 1 ? incoming[0]?.sourceHandle : null;
    return handle === "true" ? -1 : handle === "false" ? 1 : 0;
  };
  const bands: WorkflowNode[][] = [];
  // Build connected vertical intervals, including stubs under staggered cards.
  for (const stub of sortBy(stubs, [(node) => node.position.y])) {
    const band = bands.at(-1);
    const last = band?.at(-1);
    if (
      band &&
      last &&
      stub.position.y < last.position.y + GROUP_BOUNDARY_STUB_HEIGHT + gap
    )
      band.push(stub);
    else bands.push([stub]);
  }
  const positions = new Map(
    bands.flatMap((band) => {
      const ordered = sortBy(band, [(node) => node.position.x, branchOrder]);
      let right = -Infinity;
      const placed = ordered.map((stub) => {
        const x = Math.max(stub.position.x, right + gap);
        right = x + WORKFLOW_NODE_WIDTH;
        return { stub, x };
      });
      const last = ordered.at(-1)!;
      const shift = (right - last.position.x - WORKFLOW_NODE_WIDTH) / 2;
      return placed.map(({ stub, x }): [string, number] => [
        stub.id,
        x - shift,
      ]);
    })
  );
  return stubs.map((stub) => {
    const x = positions.get(stub.id);
    if (x === undefined || x === stub.position.x) return stub;
    const cached = separatedStubs.get(stub);
    if (cached?.position.x === x) return cached;
    const shifted = { ...stub, position: { ...stub.position, x } };
    separatedStubs.set(stub, shifted);
    return shifted;
  });
}

const bentEdges = new WeakMap<WorkflowEdge, WorkflowEdge>();
/** Forward edges entering the same row share the midpoint of its nearest gap. */
function rowBends(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rowBottoms = new Map<number, number>();
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const bottom = source.position.y + workflowNodeDimensions(source).height;
    if (bottom < target.position.y)
      rowBottoms.set(
        target.position.y,
        Math.max(rowBottoms.get(target.position.y) ?? bottom, bottom)
      );
  }
  return edges.map((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const bottom = target && rowBottoms.get(target.position.y);
    if (
      !source ||
      !target ||
      bottom === undefined ||
      source.position.y + workflowNodeDimensions(source).height >=
        target.position.y
    )
      return edge;
    const centerY = (bottom + target.position.y) / 2;
    const cached = bentEdges.get(edge);
    if (cached?.data?.centerY === centerY) return cached;
    const bent = { ...edge, data: { ...edge.data, centerY } };
    bentEdges.set(edge, bent);
    return bent;
  });
}

export function focusedGroupCanvasGraph(
  input: CanvasGraph & { groupId: string }
): ScopeCanvasGraph | null {
  if (
    !input.nodes.some((node) => node.id === input.groupId && isGroupNode(node))
  )
    return null;
  const storedMembers = input.nodes.filter(
    (node) => node.parentId === input.groupId
  );
  const firstMember = storedMembers[0];
  if (!firstMember)
    return { nodes: [], edges: [], anchor: null, projectedNodeIds: new Set() };
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const members = storedMembers.map(projectedMember);
  const memberById = new Map(members.map((node) => [node.id, node]));
  const boundary = analyzeGroupBoundary({
    memberIds: members.map((node) => node.id),
    edges: input.edges,
  });
  const endPorts = groupEndPorts({ nodes: input.nodes, boundary });
  const ingress = boundary.externalIngress.flatMap((port) => {
    const step = byId.get(port.nodeId);
    const cards = boundary.ingressEdges.flatMap((edge) => {
      const member = memberById.get(edge.target);
      return member &&
        edge.source === port.nodeId &&
        (edge.sourceHandle ?? null) === port.handle
        ? [member]
        : [];
    });
    return step && cards.length
      ? [
          boundaryStub({
            direction: "ingress",
            step,
            port,
            position: stubPosition(cards, "ingress"),
          }),
        ]
      : [];
  });
  const continuations = [
    ...Map.groupBy(boundary.continuationEdges, (edge) =>
      groupPortKey({ nodeId: edge.target, handle: edge.targetHandle ?? null })
    ).values(),
  ].flatMap((edges) => {
    const first = edges[0];
    const step = first && byId.get(first.target);
    const cards = edges.flatMap((edge) => {
      const member = memberById.get(edge.source);
      return member ? [member] : [];
    });
    return first && step && cards.length
      ? [
          boundaryStub({
            direction: "continuation",
            step,
            port: { nodeId: first.target, handle: first.targetHandle ?? null },
            position: stubPosition(cards, "continuation"),
          }),
        ]
      : [];
  });
  const ends = endPorts.flatMap((port) => {
    const member = memberById.get(port.nodeId);
    return member
      ? [
          boundaryStub({
            direction: "end",
            step: member,
            port,
            position: stubPosition([member], "end"),
          }),
        ]
      : [];
  });
  const paintedEndEdges = endPorts.map(endEdge);
  endEdges = new Map(paintedEndEdges.map((edge) => [edge.id, edge]));
  endStubs = new Map(ends.map((node) => [node.id, node]));
  const edges = [
    ...boundary.interiorEdges,
    ...boundary.ingressEdges.map((edge) => focusedEdge(edge, "ingress")),
    ...boundary.continuationEdges.map((edge) =>
      focusedEdge(edge, "continuation")
    ),
    ...paintedEndEdges,
  ];
  const stubs = separateBoundaryStubs(
    [...ingress, ...continuations, ...ends],
    edges
  );
  const nodes = [
    ...stubs.slice(0, ingress.length),
    ...members,
    ...stubs.slice(ingress.length),
  ];
  return {
    nodes,
    edges: rowBends(nodes, edges),
    anchor: { nodeId: firstMember.id, pinToTop: false },
    projectedNodeIds: new Set(
      [...ingress, ...continuations, ...ends].map((node) => node.id)
    ),
  };
}

export function scopeCanvasGraph(
  input: CanvasGraph & { scope: WorkspaceScope }
): ScopeCanvasGraph {
  return input.scope.kind === "group"
    ? (focusedGroupCanvasGraph({ ...input, groupId: input.scope.groupId }) ??
        overviewCanvasGraph(input))
    : overviewCanvasGraph(input);
}

export function withoutProjectedDimensions(
  changes: NodeChange<WorkflowNode>[],
  projectedNodeIds: ReadonlySet<string>
): NodeChange<WorkflowNode>[] {
  const kept = changes.filter(
    (change) => change.type !== "dimensions" || !projectedNodeIds.has(change.id)
  );
  return kept.length === changes.length ? changes : kept;
}
