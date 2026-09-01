import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { workflowEdgeAriaLabel } from "#src/components/flow-elements/edge-label";
import {
  workflowNodeAriaLabel,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
} from "#src/lib/workflow-node-dimensions";

const accessibleNodeCache = new WeakMap<
  WorkflowNode,
  { label: string; node: WorkflowNode }
>();
const dimensionedNodeCache = new WeakMap<WorkflowNode, WorkflowNode>();
const accessibleEdgeCache = new WeakMap<
  WorkflowEdge,
  { label: string; edge: WorkflowEdge }
>();
type AccessibleNodeArray = {
  catalog: ExtensionCatalog;
  labels: ReadonlyMap<string, string>;
  nodes: WorkflowNode[];
};
const accessibleNodeArrayCache = new WeakMap<
  WorkflowNode[],
  AccessibleNodeArray
>();
const accessibleEdgeArrayCache = new WeakMap<
  WorkflowEdge[],
  { nodeArray: AccessibleNodeArray; edges: WorkflowEdge[] }
>();

export function canvasNodeWithInitialDimensions(
  node: WorkflowNode
): WorkflowNode {
  const initialWidth =
    node.initialWidth ??
    node.measured?.width ??
    node.width ??
    WORKFLOW_NODE_WIDTH;
  const initialHeight =
    node.initialHeight ??
    node.measured?.height ??
    node.height ??
    WORKFLOW_NODE_HEIGHT;
  if (
    node.initialWidth === initialWidth &&
    node.initialHeight === initialHeight
  ) {
    return node;
  }
  const cached = dimensionedNodeCache.get(node);
  if (cached) {
    return cached;
  }
  const dimensioned = { ...node, initialWidth, initialHeight };
  dimensionedNodeCache.set(node, dimensioned);
  return dimensioned;
}

function withNodeAriaLabel(node: WorkflowNode, label: string): WorkflowNode {
  const dimensionedNode = canvasNodeWithInitialDimensions(node);
  if (dimensionedNode.ariaLabel === label) {
    return dimensionedNode;
  }
  const cached = accessibleNodeCache.get(node);
  if (cached?.label === label) {
    return cached.node;
  }
  const accessible = { ...dimensionedNode, ariaLabel: label };
  accessibleNodeCache.set(node, { label, node: accessible });
  return accessible;
}

function withEdgeAriaLabel(edge: WorkflowEdge, label: string): WorkflowEdge {
  if (edge.ariaLabel === label) {
    return edge;
  }
  const cached = accessibleEdgeCache.get(edge);
  if (cached?.label === label) {
    return cached.edge;
  }
  const accessible = { ...edge, ariaLabel: label };
  accessibleEdgeCache.set(edge, { label, edge: accessible });
  return accessible;
}

export function accessibleGraphElements(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  catalog: ExtensionCatalog
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const cachedNodes = accessibleNodeArrayCache.get(nodes);
  let nodeArray = cachedNodes;
  if (nodeArray?.catalog !== catalog) {
    const labels = new Map(
      nodes.map(
        (node) => [node.id, workflowNodeAriaLabel(node.data, catalog)] as const
      )
    );
    nodeArray = {
      catalog,
      labels,
      nodes: nodes.map((node) =>
        withNodeAriaLabel(node, labels.get(node.id) ?? "Unknown step")
      ),
    };
    accessibleNodeArrayCache.set(nodes, nodeArray);
  }

  const cachedEdges = accessibleEdgeArrayCache.get(edges);
  const accessibleEdges =
    cachedEdges?.nodeArray === nodeArray
      ? cachedEdges.edges
      : edges.map((edge) =>
          withEdgeAriaLabel(
            edge,
            workflowEdgeAriaLabel({
              sourceLabel: nodeArray.labels.get(edge.source) ?? "Unknown step",
              targetLabel: nodeArray.labels.get(edge.target) ?? "Unknown step",
              sourceHandleId: edge.sourceHandle,
              data: edge.data,
            })
          )
        );
  if (cachedEdges?.nodeArray !== nodeArray) {
    accessibleEdgeArrayCache.set(edges, { nodeArray, edges: accessibleEdges });
  }

  return { nodes: nodeArray.nodes, edges: accessibleEdges };
}
