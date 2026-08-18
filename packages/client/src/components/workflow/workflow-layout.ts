import dagre from "@dagrejs/dagre";
import { hierarchy, tree } from "d3-hierarchy";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { eventsReachingTarget } from "#src/lib/upstream-node-fields";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";
import {
  eventSplitOutlet,
  eventSplitOutletEvent,
  isEventSplitNode,
} from "@wfgraph/shared/lifecycle/event-split";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import {
  eventSplitCardWidth,
  groupFrameSize,
  NODE_SPACING,
  RANK_SPACING,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";
import {
  edgesForGroupLayout,
  groupEntryIds,
  groupInteriorLayout,
  isGroupNode,
} from "@wfgraph/shared/graph/node-group";
import { layoutGroupChildren } from "#src/lib/node-group";

const LAYOUT_DIRECTION = "TB";
const GRAPH_MARGIN = 40;
const ROOT_ID = "__workflow-root__";

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

type TreeNodeData = {
  id: string;
  children?: TreeNodeData[];
};

type LayoutSpacing = {
  nodeSpacing: number;
  rankSpacing: number;
};

/**
 * The graph as both algorithms read it.
 *
 * `nodes` is left to right by where the nodes sit now, and each node's out-edges
 * are already in the order their handles are drawn. Both orders decide what ends
 * up left of what, so they are settled once rather than per algorithm.
 */
type LayoutModel = {
  nodes: WorkflowNode[];
  widthById: Map<string, number>;
  heightById: Map<string, number>;
  outEdgesBySource: Map<string, WorkflowEdge[]>;
};

function hasPositionChanged(
  current: WorkflowNode["position"],
  next: WorkflowNode["position"]
): boolean {
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

/**
 * Where each branching handle sits across the bottom of the node that draws it:
 * a Condition node puts True left of False, the Lifecycle node puts Started left
 * of Canceled. Siblings are only ever compared under one parent, so the two
 * pairs share their ranks without meeting.
 */
const HANDLE_SORT_RANK = new Map<string, number>([
  ["true", 0],
  ["false", 1],
  [LIFECYCLE_STARTED_HANDLE, 0],
  [LIFECYCLE_CANCELED_HANDLE, 1],
]);

/** A handle the node draws no slot for sorts after every one it does. */
const UNRANKED_HANDLE = Number.MAX_SAFE_INTEGER;

/**
 * How wide a node draws, and where each of its handles sits across the bottom.
 *
 * An Event Split draws a handle per Event that can reach it and grows wide
 * enough to hold them, so both answers come from the one walk that finds those
 * Events. Every other node is the standard width and draws the fixed pair above.
 */
function readNodeShape(input: {
  node: WorkflowNode;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  catalog: ExtensionCatalog;
}): { width: number; height: number; handleRanks: Map<string, number> } {
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
      handleRanks: HANDLE_SORT_RANK,
    };
  }

  if (!isEventSplitNode(input.node)) {
    return {
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
      handleRanks: HANDLE_SORT_RANK,
    };
  }

  const outlets = eventsReachingTarget({
    targetNodeId: input.node.id,
    nodes: input.nodes,
    edges: input.edges,
    catalog: input.catalog,
  });

  return {
    width: eventSplitCardWidth(outlets.length),
    height: WORKFLOW_NODE_HEIGHT,
    handleRanks: new Map(
      outlets.map((event, index) => [eventSplitOutlet(event.name), index])
    ),
  };
}

/**
 * One node's out-edges, left to right.
 *
 * The handle comes first, so a branch lands under the handle drawing it. Where
 * two edges leave the same handle the graph says nothing about which belongs
 * left, so the tie goes to where the targets already sit, and two at the same
 * place keep the order they were wired in, `toSorted` being stable. Nothing here
 * reads a node id: those are nanoids, so ordering on one decides left from right
 * at random and can flip between reflows.
 */
function sortOutEdges(input: {
  edges: readonly WorkflowEdge[];
  ranks: Map<string, number>;
  positionXById: Map<string, number>;
}): WorkflowEdge[] {
  const rankOf = (edge: WorkflowEdge) =>
    input.ranks.get(edge.sourceHandle ?? "") ?? UNRANKED_HANDLE;
  const positionXOf = (nodeId: string) => input.positionXById.get(nodeId) ?? 0;

  return input.edges.toSorted((a, b) => {
    const rankDiff = rankOf(a) - rankOf(b);
    if (rankDiff !== 0) {
      return rankDiff;
    }

    return positionXOf(a.target) - positionXOf(b.target);
  });
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

  const widthById = new Map<string, number>();
  const heightById = new Map<string, number>();
  for (const node of input.nodes) {
    const shape = readNodeShape({
      node,
      nodes: input.allNodes,
      edges: input.allEdges,
      catalog: input.catalog,
    });
    widthById.set(node.id, shape.width);
    heightById.set(node.id, shape.height);

    outEdgesBySource.set(
      node.id,
      sortOutEdges({
        edges: outEdgesBySource.get(node.id) ?? [],
        ranks: shape.handleRanks,
        positionXById,
      })
    );
  }

  return {
    nodes: input.nodes.toSorted((a, b) => a.position.x - b.position.x),
    widthById,
    heightById,
    outEdgesBySource,
  };
}

function layoutWorkflowNodesWithDagre(input: {
  nodes: WorkflowNode[];
  model: LayoutModel;
  spacing: LayoutSpacing;
}): {
  nodes: WorkflowNode[];
  changed: boolean;
} {
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

  const widthOf = (nodeId: string) =>
    input.model.widthById.get(nodeId) ?? WORKFLOW_NODE_WIDTH;
  const heightOf = (nodeId: string) =>
    input.model.heightById.get(nodeId) ?? WORKFLOW_NODE_HEIGHT;

  for (const node of input.model.nodes) {
    graph.setNode(node.id, {
      width: widthOf(node.id),
      height: heightOf(node.id),
    });
  }

  // dagre seeds its ordering pass from insertion order, so nodes and edges go in
  // the left-to-right order the canvas already draws them in.
  for (const node of input.model.nodes) {
    for (const edge of input.model.outEdgesBySource.get(node.id) ?? []) {
      graph.setEdge(edge.source, edge.target, {
        weight: getEdgeWeight(edge),
      });
    }
  }

  dagre.layout(graph);

  let changed = false;

  const nodes = input.nodes.map((node) => {
    const layoutNode = getLayoutNode(graph, node.id);
    if (!layoutNode) {
      return node;
    }

    const nextPosition = {
      x: Math.round(layoutNode.x - widthOf(node.id) / 2),
      y: Math.round(layoutNode.y - heightOf(node.id) / 2),
    };

    if (!hasPositionChanged(node.position, nextPosition)) {
      return node;
    }

    changed = true;

    return {
      ...node,
      position: nextPosition,
    };
  });

  return { nodes, changed };
}

function buildTreeLayoutData(input: {
  nodes: WorkflowNode[];
  model: LayoutModel;
}): TreeNodeData | null {
  const inDegree = new Map<string, number>(
    input.nodes.map((node) => [node.id, 0])
  );

  for (const edges of input.model.outEdgesBySource.values()) {
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

  const roots = input.model.nodes.filter(
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

    const childEdges = input.model.outEdgesBySource.get(nodeId) ?? [];
    const children: TreeNodeData[] = [];

    for (const edge of childEdges) {
      const childNode = buildNode(edge.target);
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

  if (seen.size !== input.nodes.length) {
    return null;
  }

  return {
    id: ROOT_ID,
    children: rootChildren,
  };
}

function layoutWorkflowNodesWithHierarchy(input: {
  nodes: WorkflowNode[];
  model: LayoutModel;
  spacing: LayoutSpacing;
}): {
  nodes: WorkflowNode[];
  changed: boolean;
} | null {
  if (input.nodes.some((node) => isGroupNode(node))) {
    return null;
  }
  const treeData = buildTreeLayoutData({
    nodes: input.nodes,
    model: input.model,
  });

  if (!treeData) {
    return null;
  }

  const widthOf = (nodeId: string) =>
    input.model.widthById.get(nodeId) ?? WORKFLOW_NODE_WIDTH;

  const root = hierarchy(treeData, (node) => node.children ?? []);
  // `nodeSize` is one size for every node, so a node wider than the rest asks
  // for its room through `separation`, which answers a centre-to-centre distance
  // in those units. Two default-width siblings come to 1, the pair of them a gap
  // apart, and cousins to the same 1.4 that a fixed separation used to give.
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

  const positionedDescendants = root
    .descendants()
    .filter((node) => node.data.id !== ROOT_ID);

  if (positionedDescendants.length === 0) {
    return { nodes: input.nodes, changed: false };
  }

  const topLeftById = new Map<string, { x: number; y: number }>();
  for (const descendant of positionedDescendants) {
    const centerX = descendant.x ?? 0;
    const centerY = descendant.y ?? 0;
    topLeftById.set(descendant.data.id, {
      x: centerX - widthOf(descendant.data.id) / 2,
      y: centerY - WORKFLOW_NODE_HEIGHT / 2,
    });
  }

  const topLeftPositions = Array.from(topLeftById.values());
  const minX = Math.min(...topLeftPositions.map((position) => position.x));
  const minY = Math.min(...topLeftPositions.map((position) => position.y));

  let changed = false;

  const nodes = input.nodes.map((node) => {
    const rawPosition = topLeftById.get(node.id);
    if (!rawPosition) {
      return node;
    }

    const nextPosition = {
      x: Math.round(rawPosition.x - minX + GRAPH_MARGIN),
      y: Math.round(rawPosition.y - minY + GRAPH_MARGIN),
    };

    if (!hasPositionChanged(node.position, nextPosition)) {
      return node;
    }

    changed = true;

    return {
      ...node,
      position: nextPosition,
    };
  });

  return { nodes, changed };
}

function isLayoutableNode(node: WorkflowNode): boolean {
  return node.type !== "add" && !node.parentId;
}

export function layoutWorkflowNodes(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  availableWidth?: number;
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

  const treeLayoutResult = layoutWorkflowNodesWithHierarchy({
    nodes: layoutableNodes,
    model,
    spacing,
  });

  const positionedNodes =
    treeLayoutResult ??
    layoutWorkflowNodesWithDagre({
      nodes: layoutableNodes,
      model,
      spacing,
    });

  const nextById = new Map(
    positionedNodes.nodes.map((node) => [node.id, node])
  );
  const positioned = input.nodes.map((node) => {
    const next = nextById.get(node.id);
    if (!next) {
      return node;
    }
    return {
      ...node,
      position: next.position,
    };
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
