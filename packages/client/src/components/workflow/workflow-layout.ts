import dagre from "@dagrejs/dagre";
import { hierarchy, tree } from "d3-hierarchy";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/graph/types";
import {
  LIFECYCLE_CANCELED_HANDLE,
  LIFECYCLE_STARTED_HANDLE,
} from "@rova/shared/lifecycle/lifecycle-outlets";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "./workflow-node-dimensions";

const LAYOUT_DIRECTION = "TB";
const NODE_SPACING = 132;
const RANK_SPACING = 118;
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

function hasPositionChanged(
  current: WorkflowNode["position"],
  next: WorkflowNode["position"]
): boolean {
  return current.x !== next.x || current.y !== next.y;
}

function sortById<T extends { id: string }>(items: T[]): T[] {
  return items.toSorted((a, b) => a.id.localeCompare(b.id));
}

function getEdgeWeight(edge: WorkflowEdge): number {
  if (edge.sourceHandle === "true") {
    return 4;
  }

  if (edge.sourceHandle === "false") {
    return 3;
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
    return { nodeSpacing: 96, rankSpacing: 96 };
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

function layoutWorkflowNodesWithDagre(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
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

  graph.setGraph({
    rankdir: LAYOUT_DIRECTION,
    align: "UL",
    nodesep: input.spacing.nodeSpacing,
    ranksep: input.spacing.rankSpacing,
    marginx: GRAPH_MARGIN,
    marginy: GRAPH_MARGIN,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const sortedNodes = sortById(input.nodes);
  const nodeMap = new Map(sortedNodes.map((node) => [node.id, node]));

  for (const node of sortedNodes) {
    graph.setNode(node.id, {
      width: WORKFLOW_NODE_WIDTH,
      height: WORKFLOW_NODE_HEIGHT,
    });
  }

  for (const edge of sortById(input.edges)) {
    if (!(nodeMap.has(edge.source) && nodeMap.has(edge.target))) {
      continue;
    }

    graph.setEdge(edge.source, edge.target, {
      weight: getEdgeWeight(edge),
    });
  }

  dagre.layout(graph);

  let changed = false;

  const nodes = input.nodes.map((node) => {
    const layoutNode = getLayoutNode(graph, node.id);
    if (!layoutNode) {
      return node;
    }

    const nextPosition = {
      x: Math.round(layoutNode.x - WORKFLOW_NODE_WIDTH / 2),
      y: Math.round(layoutNode.y - WORKFLOW_NODE_HEIGHT / 2),
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

const UNRANKED_HANDLE = 2;

/**
 * A subtree's place among its siblings, left to right.
 *
 * Ordering by anything else lets a reflow put the Canceled branch left of the
 * Started one, which crosses both edges under the entry node.
 */
function getTreeSortRank(sourceHandle: string | null | undefined): number {
  if (!sourceHandle) {
    return UNRANKED_HANDLE;
  }

  return HANDLE_SORT_RANK.get(sourceHandle) ?? UNRANKED_HANDLE;
}

function buildTreeLayoutData(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): TreeNodeData | null {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const inDegree = new Map<string, number>();
  const edgesBySource = new Map<string, WorkflowEdge[]>();

  for (const node of input.nodes) {
    inDegree.set(node.id, 0);
    edgesBySource.set(node.id, []);
  }

  for (const edge of input.edges) {
    if (!(nodeIds.has(edge.source) && nodeIds.has(edge.target))) {
      continue;
    }

    if (edge.source === edge.target) {
      return null;
    }

    edgesBySource.get(edge.source)?.push(edge);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);

    if ((inDegree.get(edge.target) ?? 0) > 1) {
      return null;
    }
  }

  for (const [sourceId, edges] of edgesBySource) {
    edgesBySource.set(
      sourceId,
      edges.toSorted((a, b) => {
        const rankDiff =
          getTreeSortRank(a.sourceHandle ?? null) -
          getTreeSortRank(b.sourceHandle ?? null);
        if (rankDiff !== 0) {
          return rankDiff;
        }

        return a.target.localeCompare(b.target);
      })
    );
  }

  const roots = input.nodes
    .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
    .toSorted((a, b) => a.id.localeCompare(b.id));

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

    const childEdges = edgesBySource.get(nodeId) ?? [];
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
  edges: WorkflowEdge[];
  spacing: LayoutSpacing;
}): {
  nodes: WorkflowNode[];
  changed: boolean;
} | null {
  const treeData = buildTreeLayoutData({
    nodes: input.nodes,
    edges: input.edges,
  });

  if (!treeData) {
    return null;
  }

  const root = hierarchy(treeData, (node) => node.children ?? []);
  const treeLayout = tree<TreeNodeData>()
    .nodeSize([
      WORKFLOW_NODE_WIDTH + input.spacing.nodeSpacing,
      WORKFLOW_NODE_HEIGHT + input.spacing.rankSpacing,
    ])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.4));

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
      x: centerX - WORKFLOW_NODE_WIDTH / 2,
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
  return node.type !== "add";
}

export function layoutWorkflowNodes(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  availableWidth?: number;
}): {
  nodes: WorkflowNode[];
  changed: boolean;
} {
  const layoutableNodes = input.nodes.filter(isLayoutableNode);
  if (layoutableNodes.length === 0) {
    return { nodes: input.nodes, changed: false };
  }

  const layoutableNodeIds = new Set(layoutableNodes.map((node) => node.id));
  const layoutableEdges = input.edges.filter(
    (edge) =>
      layoutableNodeIds.has(edge.source) && layoutableNodeIds.has(edge.target)
  );
  const spacing = getLayoutSpacing(input.availableWidth);

  const treeLayoutResult = layoutWorkflowNodesWithHierarchy({
    nodes: layoutableNodes,
    edges: layoutableEdges,
    spacing,
  });

  const positionedNodes =
    treeLayoutResult ??
    layoutWorkflowNodesWithDagre({
      nodes: layoutableNodes,
      edges: layoutableEdges,
      spacing,
    });

  const nextById = new Map(
    positionedNodes.nodes.map((node) => [node.id, node])
  );
  let changed = false;
  const nodes = input.nodes.map((node) => {
    const next = nextById.get(node.id);
    if (!next) {
      return node;
    }

    if (!hasPositionChanged(node.position, next.position)) {
      return node;
    }

    changed = true;
    return {
      ...node,
      position: next.position,
    };
  });

  return { nodes, changed };
}
