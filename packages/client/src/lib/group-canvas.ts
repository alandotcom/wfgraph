/**
 * How the canvas paints Groups: in place, as a region around its members, or
 * as one card when the viewer collapsed it. A region's node box is sized from
 * its members' stored local positions; members stay React Flow child nodes of
 * the frame, held inside it. Projection never writes positions or sizes.
 */
import { omit } from "es-toolkit/object";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  displayEdgesForGroups,
  fanOutStoreEdgeIds,
} from "@wfgraph/shared/graph/node-group";
import {
  GROUP_REGION_INSET,
  groupRegionBox,
} from "@wfgraph/shared/graph/workflow-layout-geometry";
import type { NodeChange } from "@xyflow/react";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";

export type CanvasGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
export type PaintedCanvasGraph = CanvasGraph & {
  /** The Lifecycle card, which the camera's placements anchor on. */
  anchor: { nodeId: string } | null;
  /** Only painted frames have measurements that must not be stored. */
  projectedNodeIds: ReadonlySet<string>;
};

const CARD_SIZE = { width: WORKFLOW_NODE_WIDTH, height: WORKFLOW_NODE_HEIGHT };

/**
 * `nodes` as the frame-aware edge helpers should read them: a member of a
 * Group drawn in place loses its `parentId`, because its edges attach to the
 * member itself, and only a collapsed Group's members keep it, so their
 * boundary edges paint on the collapsed card.
 */
export function groupingAsPainted(
  nodes: readonly WorkflowNode[],
  collapsedGroupIds: ReadonlySet<string>
): WorkflowNode[] {
  return nodes.map((node) =>
    node.parentId !== undefined && !collapsedGroupIds.has(node.parentId)
      ? omit(node, ["parentId"])
      : node
  );
}

/**
 * The stored edge ids that deleting the painted edge `edgeId` removes. A
 * painted edge on a collapsed Group card stands for every stored edge it
 * collapses; every other painted edge is the stored edge of the same id.
 */
export function storedEdgeIdsForPaintedEdge(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  edgeId: string;
  collapsedGroupIds: ReadonlySet<string>;
}): string[] {
  return fanOutStoreEdgeIds(
    groupingAsPainted(input.nodes, input.collapsedGroupIds),
    input.edges,
    input.edgeId
  );
}

const collapsedFrames = new WeakMap<WorkflowNode, WorkflowNode>();
function collapsedFrame(frame: WorkflowNode): WorkflowNode {
  const cached = collapsedFrames.get(frame);
  if (cached) return cached;
  const collapsed: WorkflowNode = {
    ...frame,
    ...CARD_SIZE,
    measured: CARD_SIZE,
    style: { ...omit(frame.style ?? {}, ["width", "height"]), ...CARD_SIZE },
  };
  collapsedFrames.set(frame, collapsed);
  return collapsed;
}

const regionFrames = new WeakMap<WorkflowNode, WorkflowNode>();
function regionFrame(
  frame: WorkflowNode,
  members: readonly WorkflowNode[]
): WorkflowNode {
  const box = groupRegionBox(members);
  const cached = regionFrames.get(frame);
  if (cached?.width === box.width && cached.height === box.height) {
    return cached;
  }
  const region: WorkflowNode = {
    ...frame,
    ...box,
    measured: box,
    style: { ...omit(frame.style ?? {}, ["width", "height"]), ...box },
  };
  regionFrames.set(frame, region);
  return region;
}

const regionMembers = new WeakMap<WorkflowNode, WorkflowNode>();
/** A member drawn in its region: movable, connectable, and held inside it. */
function regionMember(member: WorkflowNode): WorkflowNode {
  const cached = regionMembers.get(member);
  if (cached) return cached;
  const painted: WorkflowNode = {
    ...omit(member, ["draggable", "connectable", "expandParent"]),
    extent: "parent",
  };
  regionMembers.set(member, painted);
  return painted;
}

/**
 * The one canvas: every step, each Group drawn in place around its members,
 * except the Groups in `collapsedGroupIds`, which draw as one card standing
 * for their members, with the boundary edges painted on the card.
 */
export function workflowCanvasGraph(
  input: CanvasGraph & { collapsedGroupIds: ReadonlySet<string> }
): PaintedCanvasGraph {
  const lifecycle = input.nodes.find((node) => node.data.type === "lifecycle");
  const anchor = lifecycle ? { nodeId: lifecycle.id } : null;
  const frameIds = new Set(
    input.nodes.filter(isGroupNode).map((node) => node.id)
  );
  if (frameIds.size === 0) {
    return { ...input, anchor, projectedNodeIds: frameIds };
  }
  const membersByFrame = Map.groupBy(
    input.nodes.filter(
      (node) => node.parentId !== undefined && frameIds.has(node.parentId)
    ),
    (node) => node.parentId ?? ""
  );
  const nodes = input.nodes.flatMap((node) => {
    if (isGroupNode(node)) {
      return [
        input.collapsedGroupIds.has(node.id)
          ? collapsedFrame(node)
          : regionFrame(node, membersByFrame.get(node.id) ?? []),
      ];
    }
    if (node.parentId === undefined || !frameIds.has(node.parentId)) {
      return [node];
    }
    return input.collapsedGroupIds.has(node.parentId)
      ? []
      : [regionMember(node)];
  });
  const shownIds = new Set(nodes.map((node) => node.id));
  const painted =
    input.collapsedGroupIds.size === 0
      ? input.edges
      : displayEdgesForGroups(
          groupingAsPainted(input.nodes, input.collapsedGroupIds),
          input.edges
        );
  const edges = painted.filter(
    (edge) => shownIds.has(edge.source) && shownIds.has(edge.target)
  );
  return { nodes, edges, anchor, projectedNodeIds: frameIds };
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

type Point = { x: number; y: number };

/**
 * Where `node` sits on the canvas: its own position, plus its frame's when it
 * is a member, since a member's stored position is local to its frame.
 */
export function absolutePosition(
  node: Pick<WorkflowNode, "position" | "parentId">,
  nodes: readonly WorkflowNode[]
): Point {
  if (node.parentId === undefined) {
    return node.position;
  }
  const frame = nodes.find((item) => item.id === node.parentId);
  return frame
    ? {
        x: frame.position.x + node.position.x,
        y: frame.position.y + node.position.y,
      }
    : node.position;
}

/**
 * The Group drawn in place whose region holds `point`, header and padding
 * included, or null. A collapsed Group holds no point, since its members are
 * not drawn.
 */
export function groupRegionAt(input: {
  point: Point;
  nodes: readonly WorkflowNode[];
  collapsedGroupIds: ReadonlySet<string>;
}): string | null {
  const { point } = input;
  const frame = input.nodes.find((node) => {
    if (!isGroupNode(node) || input.collapsedGroupIds.has(node.id)) {
      return false;
    }
    const box = groupRegionBox(
      input.nodes.filter((member) => member.parentId === node.id)
    );
    return (
      point.x >= node.position.x - GROUP_REGION_INSET.left &&
      point.y >= node.position.y - GROUP_REGION_INSET.top &&
      point.x <= node.position.x + box.width &&
      point.y <= node.position.y + box.height
    );
  });
  return frame?.id ?? null;
}

/**
 * The Group a step added or pasted beside `nodeIds` joins: the one Group that
 * holds every one of them as a member, or null.
 */
export function sharedGroupOf(
  nodeIds: readonly string[],
  nodes: readonly WorkflowNode[]
): string | null {
  const parents = new Set(
    nodeIds.map((id) => nodes.find((node) => node.id === id)?.parentId ?? null)
  );
  const [only] = parents;
  return parents.size === 1 && only !== undefined ? only : null;
}

/**
 * `inserted` with each node whose frame came with it left alone and every
 * other node made a member of `groupId`, its canvas position turned local to
 * the frame and kept inside the frame's node box. Answers `inserted` itself
 * when `groupId` is null or names no frame in `nodes`.
 */
export function joinGroup(input: {
  inserted: WorkflowNode[];
  groupId: string | null;
  nodes: readonly WorkflowNode[];
}): WorkflowNode[] {
  const frame =
    input.groupId === null
      ? undefined
      : input.nodes.find((node) => node.id === input.groupId);
  if (!frame || !isGroupNode(frame)) {
    return input.inserted;
  }
  const insertedIds = new Set(input.inserted.map((node) => node.id));
  return input.inserted.map((node) =>
    node.parentId !== undefined && insertedIds.has(node.parentId)
      ? node
      : {
          ...node,
          parentId: frame.id,
          position: {
            x: Math.max(0, node.position.x - frame.position.x),
            y: Math.max(0, node.position.y - frame.position.y),
          },
        }
  );
}

const placedMembers = new WeakMap<WorkflowNode, WorkflowNode>();
const placedRegions = new WeakMap<WorkflowNode, WorkflowNode>();
/**
 * `nodes` in one coordinate space for placement rules: each member at its
 * canvas position, with no `parentId`, and each Group drawn in place as its
 * whole outline, header and padding included, so a new step lands clear of
 * it. A rule's answer for a member is turned back into a stored position with
 * `storedPosition`.
 */
export function canvasPlacementNodes(
  nodes: readonly WorkflowNode[]
): WorkflowNode[] {
  const regionIds = new Set(
    nodes.flatMap((node) =>
      node.parentId === undefined ? [] : [node.parentId]
    )
  );
  return nodes.map((node) => {
    if (regionIds.has(node.id)) {
      const cached = placedRegions.get(node);
      if (cached) return cached;
      const width =
        (node.measured?.width ?? node.width ?? WORKFLOW_NODE_WIDTH) +
        GROUP_REGION_INSET.left;
      const height =
        (node.measured?.height ?? node.height ?? WORKFLOW_NODE_HEIGHT) +
        GROUP_REGION_INSET.top;
      const outline: WorkflowNode = {
        ...node,
        position: {
          x: node.position.x - GROUP_REGION_INSET.left,
          y: node.position.y - GROUP_REGION_INSET.top,
        },
        width,
        height,
        measured: { width, height },
      };
      placedRegions.set(node, outline);
      return outline;
    }
    if (node.parentId === undefined) {
      return node;
    }
    const position = absolutePosition(node, nodes);
    const cached = placedMembers.get(node);
    if (cached?.position.x === position.x && cached.position.y === position.y) {
      return cached;
    }
    const placed = { ...omit(node, ["parentId", "extent"]), position };
    placedMembers.set(node, placed);
    return placed;
  });
}

/**
 * The position to store for the node `nodeId` that placement put at the
 * canvas point `at`: local to its frame for a member, `at` itself otherwise.
 */
export function storedPosition(
  nodeId: string,
  at: Point,
  nodes: readonly WorkflowNode[]
): Point {
  const node = nodes.find((item) => item.id === nodeId);
  if (node?.parentId === undefined) {
    return at;
  }
  const frame = nodes.find((item) => item.id === node.parentId);
  return frame
    ? { x: at.x - frame.position.x, y: at.y - frame.position.y }
    : at;
}
