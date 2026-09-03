/**
 * Where auto-layout puts every node. Two rules the signature cannot state: an
 * outlet a branching node draws keeps its column whether or not anything is
 * wired to it, and a rank is as tall as the tallest node standing in it. Both
 * belong to the tree pass; the dagre fallback holds no column open.
 */

import dagre from "@dagrejs/dagre";
import { hierarchy, tree } from "d3-hierarchy";
import { orderBy, sortBy } from "es-toolkit/array";
import type { ExtensionCatalog } from "#src/extensions/catalog";
import { eventsReaching } from "#src/graph/events-reaching";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import {
  eventSplitOutlet,
  eventSplitOutletEvent,
  isEventSplitNode,
} from "#src/lifecycle/event-split";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "#src/lifecycle/lifecycle-outlets";
import {
  isConditionNode,
  isLifecycleNode,
} from "#src/graph/node-config";
import {
  eventSplitCardWidth,
  groupFrameSize,
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/graph/workflow-layout-geometry";
import {
  edgesForGroupLayout,
  groupEntryIds,
  groupInteriorLayout,
  isGroupNode,
} from "#src/graph/node-group";
import { layoutGroupChildren } from "#src/graph/layout-group-children";

const LAYOUT_DIRECTION = "TB";
const GRAPH_MARGIN = 40;
const ROOT_ID = "__workflow-root__";

type Position = WorkflowNode["position"];

type DagreNode = {
  x: number;
  y: number;
};

/**
 * The label we hang on each dagre node.
 *
 * We hand dagre a width and a height; `dagre.layout` then writes the computed
 * centre back onto the very same label object, which is why x and y are
 * optional here. graphlib answers `undefined` for an id that was never added,
 * so that possibility belongs in the label type too.
 */
type DagreNodeLabel =
  | {
      width: number;
      height: number;
      x?: number;
      y?: number;
    }
  | undefined;

type DagreEdgeLabel = {
  weight?: number;
};

/**
 * graphlib's Graph takes its three label types as parameters and defaults all
 * of them to `any`. Naming ours here gives `graph.node(id)` a real shape, so
 * reading a computed position back out is a plain property access.
 */
type DagreLayoutGraph = dagre.graphlib.Graph<
  dagre.GraphLabel,
  DagreNodeLabel,
  DagreEdgeLabel
>;

/** A node d3 places. `null` is a column held open, which no node ever fills. */
type TreeNodeData = {
  id: string | null;
  children?: TreeNodeData[];
};

/** One node d3 has placed, with the held columns already dropped. */
type PlacedNode = {
  id: string;
  /** Which rank it stands in, counting the synthetic root as rank -1. */
  depth: number;
  centerX: number;
};

type LayoutSpacing = {
  nodeSpacing: number;
  rankSpacing: number;
};

type NodeSize = {
  width: number;
  height: number;
};

/**
 * The graph as both algorithms read it.
 *
 * `nodes` is left to right by where the nodes sit now, and each node's edges are
 * already in the order their handles are drawn. Both orders decide what ends up
 * left of what, so they are settled once rather than per algorithm.
 */
type LayoutModel = {
  nodes: WorkflowNode[];
  sizeById: Map<string, NodeSize>;
  outEdgesBySource: Map<string, WorkflowEdge[]>;
  /**
   * Each node's children for the tree pass, left to right: the node an edge
   * leads to, or `null` for a column held open under an unwired outlet.
   */
  treeChildrenBySource: Map<string, Array<string | null>>;
};

/** What one node draws: how large, and which outlets across its bottom. */
type NodeShape = NodeSize & {
  /** The outlets the node draws, left to right. */
  outletHandles: readonly string[];
  /** Whether an outlet nothing is wired to still takes a column. */
  holdsOutletsOpen: boolean;
};

function hasPositionChanged(current: Position, next: Position): boolean {
  return current.x !== next.x || current.y !== next.y;
}

function getEdgeWeight(edge: WorkflowEdge): number {
  if (edge.sourceHandle === "true") {
    return 4;
  }

  if (edge.sourceHandle === "false") {
    return 3;
  }

  // An Event Split's outlets are all branches, with no trunk among them to keep
  // straighter than the rest.
  if (eventSplitOutletEvent(edge.sourceHandle)) {
    return 4;
  }

  return 6;
}

function getLayoutSpacing(availableWidth?: number): LayoutSpacing {
  if (
    !(typeof availableWidth === "number" && Number.isFinite(availableWidth))
  ) {
    return { nodeSpacing: NODE_SPACING, rankSpacing: RANK_SPACING };
  }

  if (availableWidth < 1024) {
    return { nodeSpacing: 96, rankSpacing: 72 };
  }

  return { nodeSpacing: NODE_SPACING, rankSpacing: RANK_SPACING };
}

function getLayoutNode(
  graph: DagreLayoutGraph,
  nodeId: string
): DagreNode | null {
  const label = graph.node(nodeId);
  // A label with no centre on it means dagre never placed this node, so the
  // caller should keep whatever position the node already had.
  if (label?.x === undefined || label.y === undefined) {
    return null;
  }

  return { x: label.x, y: label.y };
}

/** The Lifecycle node's outlets, in the order it draws them along its bottom. */
const LIFECYCLE_OUTLETS: readonly string[] = [
  LIFECYCLE_STARTED_HANDLE,
  LIFECYCLE_CANCELED_HANDLE,
];
/** A Condition's outlets, in that same reading order. */
const CONDITION_OUTLETS: readonly string[] = ["true", "false"];

/** A handle the node draws no slot for sorts after every one it does. */
const UNRANKED_HANDLE = Number.MAX_SAFE_INTEGER;

/** Every node but an Event Split and a Group draws at the one card size. */
function standardCard(options: {
  outletHandles: readonly string[];
  holdsOutletsOpen: boolean;
}): NodeShape {
  const { outletHandles, holdsOutletsOpen } = options;
  return {
    width: WORKFLOW_NODE_WIDTH,
    height: WORKFLOW_NODE_HEIGHT,
    outletHandles,
    holdsOutletsOpen,
  };
}

/**
 * How large a node draws, and which outlets it puts across its bottom.
 *
 * An Event Split draws a handle per Event that can reach it and grows wide
 * enough to hold them, so both answers come from the one walk that finds those
 * Events. Its outlets hold no column open, because the card already carries a
 * slot for each. The Lifecycle and Condition pairs do hold one, which is what
 * keeps a branch in its own column while its sibling is still unwired.
 */
function readNodeShape(input: {
  node: WorkflowNode;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): NodeShape {
  if (isGroupNode(input.node)) {
    const children = input.nodes.filter(
      (node) => node.parentId === input.node.id
    );
    const memberIds = children.map((child) => child.id);
    const memberSet = new Set(memberIds);
    const interior = input.edges.filter(
      (edge) => memberSet.has(edge.source) && memberSet.has(edge.target)
    );
    const { bounds } = groupInteriorLayout(
      memberIds,
      interior,
      groupEntryIds(input.node)
    );
    const size = groupFrameSize(bounds.columns, bounds.rows);
    return {
      width: size.width,
      height: size.height,
      outletHandles: [],
      holdsOutletsOpen: false,
    };
  }

  if (isLifecycleNode(input.node)) {
    return standardCard({
      outletHandles: LIFECYCLE_OUTLETS,
      holdsOutletsOpen: true,
    });
  }

  if (isConditionNode(input.node)) {
    return standardCard({
      outletHandles: CONDITION_OUTLETS,
      holdsOutletsOpen: true,
    });
  }

  if (!isEventSplitNode(input.node)) {
    return standardCard({ outletHandles: [], holdsOutletsOpen: false });
  }

  const outlets = eventsReaching({
    targetNodeId: input.node.id,
    nodes: input.nodes,
    edges: input.edges,
    catalog: input.catalog,
  });

  return {
    width: eventSplitCardWidth(outlets.length),
    height: WORKFLOW_NODE_HEIGHT,
    outletHandles: outlets.map((event) => eventSplitOutlet(event.name)),
    holdsOutletsOpen: false,
  };
}

function rankOfHandle(
  ranks: ReadonlyMap<string, number>,
  sourceHandle: string | null | undefined
): number {
  return ranks.get(sourceHandle ?? "") ?? UNRANKED_HANDLE;
}

/**
 * One node's out-edges, left to right.
 *
 * The handle comes first, so a branch lands under the handle drawing it. Where
 * two edges leave the same handle the graph says nothing about which belongs
 * left, so the tie goes to where the targets already sit, and two at the same
 * place keep the order they were wired in, `orderBy` being stable. Nothing here
 * reads a node id: those are nanoids, so ordering on one decides left from right
 * at random and can flip between reflows.
 */
function sortOutEdges(input: {
  edges: readonly WorkflowEdge[];
  ranks: ReadonlyMap<string, number>;
  positionXById: Map<string, number>;
}): WorkflowEdge[] {
  const positionXOf = (nodeId: string) => input.positionXById.get(nodeId) ?? 0;

  return orderBy(
    input.edges,
    [
      (edge) => rankOfHandle(input.ranks, edge.sourceHandle),
      (edge) => positionXOf(edge.target),
    ],
    ["asc", "asc"]
  );
}

/**
 * One node's children for the tree pass, left to right, with a column held open
 * under every outlet the node draws that nothing is wired to.
 *
 * A node whose out-edges name none of its outlets holds nothing open. The graph
 * is then saying it does not use the branching this node offers, and inventing
 * both columns there would push the one child it has off to one side.
 */
function buildTreeChildren(input: {
  /** This node's out-edges, already left to right. */
  edges: readonly WorkflowEdge[];
  shape: NodeShape;
  ranks: ReadonlyMap<string, number>;
}): Array<string | null> {
  const wired = new Set(input.edges.map((edge) => edge.sourceHandle ?? ""));
  const held = input.shape.holdsOutletsOpen
    ? input.shape.outletHandles.filter((handle) => !wired.has(handle))
    : [];

  if (held.length === 0 || held.length === input.shape.outletHandles.length) {
    return input.edges.map((edge) => edge.target);
  }

  const ranked: Array<{ rank: number; child: string | null }> = [
    ...input.edges.map((edge) => ({
      rank: rankOfHandle(input.ranks, edge.sourceHandle),
      child: edge.target as string | null,
    })),
    ...held.map((handle) => ({
      rank: rankOfHandle(input.ranks, handle),
      child: null,
    })),
  ];

  // A held handle carries no edge, so the two lists share no rank and the stable
  // sort leaves the wired order the caller settled.
  return sortBy(ranked, [(entry) => entry.rank]).map((entry) => entry.child);
}

function buildLayoutModel(input: {
  nodes: WorkflowNode[];
  allNodes: WorkflowNode[];
  edges: WorkflowEdge[];
  allEdges: WorkflowEdge[];
  catalog: ExtensionCatalog;
}): LayoutModel {
  const positionXById = new Map(
    input.nodes.map((node) => [node.id, node.position.x])
  );

  const outEdgesBySource = new Map<string, WorkflowEdge[]>(
    input.nodes.map((node) => [node.id, []])
  );
  for (const edge of input.edges) {
    outEdgesBySource.get(edge.source)?.push(edge);
  }

  const sizeById = new Map<string, NodeSize>();
  const treeChildrenBySource = new Map<string, Array<string | null>>();
  for (const node of input.nodes) {
    const shape = readNodeShape({
      node,
      nodes: input.allNodes,
      edges: input.allEdges,
      catalog: input.catalog,
    });
    sizeById.set(node.id, { width: shape.width, height: shape.height });

    const ranks = new Map(
      shape.outletHandles.map((handle, index) => [handle, index])
    );
    const edges = sortOutEdges({
      edges: outEdgesBySource.get(node.id) ?? [],
      ranks,
      positionXById,
    });
    outEdgesBySource.set(node.id, edges);
    treeChildrenBySource.set(
      node.id,
      buildTreeChildren({ edges, shape, ranks })
    );
  }

  return {
    nodes: sortBy(input.nodes, [(node) => node.position.x]),
    sizeById,
    outEdgesBySource,
    treeChildrenBySource,
  };
}

function sizeOf(model: LayoutModel, nodeId: string): NodeSize {
  return (
    model.sizeById.get(nodeId) ?? {
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
    }
  );
}

function layoutWorkflowNodesWithDagre(input: {
  model: LayoutModel;
  spacing: LayoutSpacing;
}): Map<string, Position> {
  const graph: DagreLayoutGraph = new dagre.graphlib.Graph<
    dagre.GraphLabel,
    DagreNodeLabel,
    DagreEdgeLabel
  >({
    directed: true,
    multigraph: false,
    compound: false,
  });

  // No `align`: the aligned variants pin a parent to one edge of its subtree,
  // which leaves every edge under a branching node sweeping sideways.
  graph.setGraph({
    rankdir: LAYOUT_DIRECTION,
    nodesep: input.spacing.nodeSpacing,
    ranksep: input.spacing.rankSpacing,
    marginx: GRAPH_MARGIN,
    marginy: GRAPH_MARGIN,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of input.model.nodes) {
    graph.setNode(node.id, sizeOf(input.model, node.id));
  }

  // dagre seeds its ordering pass from insertion order, so nodes and edges go in
  // the left-to-right order the canvas already draws them in. Held columns stay
  // out of this graph: dagre's median heuristic reorders a rank freely, so a
  // spare node standing in one dragged the wired branch to whichever side it
  // happened to land on.
  for (const node of input.model.nodes) {
    for (const edge of input.model.outEdgesBySource.get(node.id) ?? []) {
      graph.setEdge(edge.source, edge.target, {
        weight: getEdgeWeight(edge),
      });
    }
  }

  dagre.layout(graph);

  const positions = new Map<string, Position>();
  for (const node of input.model.nodes) {
    const layoutNode = getLayoutNode(graph, node.id);
    if (!layoutNode) {
      continue;
    }

    const size = sizeOf(input.model, node.id);
    positions.set(node.id, {
      x: Math.round(layoutNode.x - size.width / 2),
      y: Math.round(layoutNode.y - size.height / 2),
    });
  }

  return positions;
}

function buildTreeLayoutData(model: LayoutModel): TreeNodeData | null {
  const inDegree = new Map<string, number>(
    model.nodes.map((node) => [node.id, 0])
  );

  for (const edges of model.outEdgesBySource.values()) {
    for (const edge of edges) {
      if (edge.source === edge.target) {
        return null;
      }

      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);

      if ((inDegree.get(edge.target) ?? 0) > 1) {
        return null;
      }
    }
  }

  const roots = model.nodes.filter(
    (node) => (inDegree.get(node.id) ?? 0) === 0
  );

  if (roots.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const visitStack = new Set<string>();

  function buildNode(nodeId: string): TreeNodeData | null {
    if (visitStack.has(nodeId)) {
      return null;
    }

    visitStack.add(nodeId);
    seen.add(nodeId);

    const children: TreeNodeData[] = [];

    for (const child of model.treeChildrenBySource.get(nodeId) ?? []) {
      if (child === null) {
        children.push({ id: null });
        continue;
      }

      const childNode = buildNode(child);
      if (!childNode) {
        return null;
      }

      children.push(childNode);
    }

    visitStack.delete(nodeId);

    if (children.length === 0) {
      return { id: nodeId };
    }

    return { id: nodeId, children };
  }

  const rootChildren: TreeNodeData[] = [];
  for (const root of roots) {
    const built = buildNode(root.id);
    if (!built) {
      return null;
    }

    rootChildren.push(built);
  }

  if (seen.size !== model.nodes.length) {
    return null;
  }

  return {
    id: ROOT_ID,
    children: rootChildren,
  };
}

/**
 * The top of each rank and how tall it is. d3 writes one pitch onto every rank
 * alike, which would run a Group frame through the rank below it, so each rank
 * is measured from the tallest node standing in it and the next starts under
 * that. Both arrays are indexed by rank, which is a node's depth less one.
 */
function measureRanks(input: {
  placed: readonly PlacedNode[];
  heightOf: (nodeId: string) => number;
  rankSpacing: number;
}): { tops: number[]; heights: number[] } {
  let rankCount = 0;
  for (const node of input.placed) {
    rankCount = Math.max(rankCount, node.depth);
  }

  const heights = Array.from({ length: rankCount }, () => 0);
  for (const node of input.placed) {
    const rank = node.depth - 1;
    heights[rank] = Math.max(heights[rank], input.heightOf(node.id));
  }

  const tops = Array.from({ length: rankCount }, () => 0);
  let nextTop = 0;
  for (let rank = 0; rank < rankCount; rank += 1) {
    tops[rank] = nextTop;
    nextTop += heights[rank] + input.rankSpacing;
  }

  return { tops, heights };
}

function layoutWorkflowNodesWithHierarchy(input: {
  model: LayoutModel;
  spacing: LayoutSpacing;
}): Map<string, Position> | null {
  const treeData = buildTreeLayoutData(input.model);

  if (!treeData) {
    return null;
  }

  // A held column takes the room a standard card would, which is the room the
  // branch will need once someone wires it.
  const widthOf = (nodeId: string | null) =>
    nodeId === null ? WORKFLOW_NODE_WIDTH : sizeOf(input.model, nodeId).width;
  const heightOf = (nodeId: string) => sizeOf(input.model, nodeId).height;

  const root = hierarchy(treeData, (node) => node.children ?? []);
  // `nodeSize` is one size for every node, so a node wider than the rest asks
  // for its room through `separation`, which answers a centre-to-centre distance
  // in those units. Two default-width siblings come to 1, the pair of them a gap
  // apart, and cousins to the same 1.4 that a fixed separation used to give. The
  // height it takes is the pitch d3 writes onto every rank alike, which
  // `measureRanks` then replaces.
  const unitWidth = WORKFLOW_NODE_WIDTH + input.spacing.nodeSpacing;
  const treeLayout = tree<TreeNodeData>()
    .nodeSize([unitWidth, WORKFLOW_NODE_HEIGHT + input.spacing.rankSpacing])
    .separation((a, b) => {
      const gap =
        a.parent === b.parent
          ? input.spacing.nodeSpacing
          : input.spacing.nodeSpacing * 2;

      return (
        (widthOf(a.data.id) / 2 + widthOf(b.data.id) / 2 + gap) / unitWidth
      );
    });

  treeLayout(root);

  // A held column is placed like any other child and then dropped. Its rank is
  // one a wired sibling already stands in, so dropping it changes no geometry.
  const placed: PlacedNode[] = [];
  for (const descendant of root.descendants()) {
    const id = descendant.data.id;
    if (id === null || id === ROOT_ID) {
      continue;
    }

    placed.push({ id, depth: descendant.depth, centerX: descendant.x ?? 0 });
  }

  if (placed.length === 0) {
    return new Map();
  }

  const ranks = measureRanks({
    placed,
    heightOf,
    rankSpacing: input.spacing.rankSpacing,
  });

  const topLeftById = new Map<string, Position>();
  for (const node of placed) {
    const rank = node.depth - 1;
    topLeftById.set(node.id, {
      x: node.centerX - widthOf(node.id) / 2,
      // A short card sits centred in a rank a taller node set, which is what the
      // dagre fallback does with a rank holding two heights.
      y:
        (ranks.tops[rank] ?? 0) +
        ((ranks.heights[rank] ?? 0) - heightOf(node.id)) / 2,
    });
  }

  const topLeftPositions = Array.from(topLeftById.values());
  const minX = Math.min(...topLeftPositions.map((position) => position.x));
  const minY = Math.min(...topLeftPositions.map((position) => position.y));

  const positions = new Map<string, Position>();
  for (const [nodeId, topLeft] of topLeftById) {
    positions.set(nodeId, {
      x: Math.round(topLeft.x - minX + GRAPH_MARGIN),
      y: Math.round(topLeft.y - minY + GRAPH_MARGIN),
    });
  }

  return positions;
}

function isLayoutableNode(node: WorkflowNode): boolean {
  return node.type !== "add" && !node.parentId;
}

type WorkflowLayoutInput<TNode extends WorkflowNode = WorkflowNode> = {
  nodes: TNode[];
  edges: WorkflowEdge[];
  availableWidth?: number | undefined;
  catalog: ExtensionCatalog;
};

type WorkflowLayoutResult<TNode extends WorkflowNode = WorkflowNode> = {
  nodes: TNode[];
  changed: boolean;
};

/**
 * Preserves each caller's node view-model while changing only persisted layout
 * fields. The implementation never removes properties from a node.
 */
export function layoutWorkflowNodes<TNode extends WorkflowNode>(
  input: WorkflowLayoutInput<TNode>
): WorkflowLayoutResult<TNode>;
export function layoutWorkflowNodes(input: WorkflowLayoutInput): WorkflowLayoutResult;
export function layoutWorkflowNodes(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  availableWidth?: number | undefined;
  catalog: ExtensionCatalog;
}): {
  nodes: WorkflowNode[];
  changed: boolean;
} {
  const layoutableNodes = input.nodes.filter(isLayoutableNode);
  if (layoutableNodes.length === 0) {
    return { nodes: input.nodes, changed: false };
  }

  const layoutableNodeIds = new Set(layoutableNodes.map((node) => node.id));
  const layoutableEdges = edgesForGroupLayout(input.nodes, input.edges).filter(
    (edge) =>
      layoutableNodeIds.has(edge.source) && layoutableNodeIds.has(edge.target)
  );
  const spacing = getLayoutSpacing(input.availableWidth);
  const model = buildLayoutModel({
    nodes: layoutableNodes,
    allNodes: input.nodes,
    edges: layoutableEdges,
    allEdges: input.edges,
    catalog: input.catalog,
  });

  const positions =
    layoutWorkflowNodesWithHierarchy({ model, spacing }) ??
    layoutWorkflowNodesWithDagre({ model, spacing });

  const positioned = input.nodes.map((node) => {
    const next = positions.get(node.id);
    if (!next) {
      return node;
    }
    return { ...node, position: next };
  });
  const nodes = layoutGroupChildren(positioned, input.edges);
  const previousById = new Map(input.nodes.map((node) => [node.id, node]));
  const changed = nodes.some((node) => {
    const previous = previousById.get(node.id);
    if (!previous) {
      return true;
    }
    return (
      hasPositionChanged(previous.position, node.position) ||
      previous.width !== node.width ||
      previous.height !== node.height
    );
  });

  return { nodes, changed };
}
