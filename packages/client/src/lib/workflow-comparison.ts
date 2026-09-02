/**
 * Builds the read-only graph shown while reviewing a publication comparison.
 * The server decides semantic changes; this module adds editor-only annotations
 * and a temporary location for historical nodes that a reviewer repositions.
 */

import { omit } from "es-toolkit/object";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import type { XYPosition } from "@xyflow/react";
import {
  COMPARISON_EDGE_ANNOTATION,
  COMPARISON_NODE_ANNOTATION,
  toEditorEdge,
  toEditorNode,
  type ComparisonEdgeAnnotation,
  type ComparisonNodeAnnotation,
  type WorkflowEdge,
  type WorkflowNode,
} from "#src/lib/workflow-graph-types";
import { orderGroupParentsFirst } from "@wfgraph/shared/graph/node-group";

export type ComparisonDisplayGraph = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type ComparisonPositionOverrides = Readonly<Record<string, XYPosition>>;

function absoluteBasePosition(
  node: WorkflowNode,
  nodesById: ReadonlyMap<string, WorkflowNode>,
  seen = new Set<string>()
): XYPosition {
  if (!node.parentId || seen.has(node.id)) {
    return node.position;
  }
  const parent = nodesById.get(node.parentId);
  if (!parent) {
    return node.position;
  }
  seen.add(node.id);
  const parentPosition = absoluteBasePosition(parent, nodesById, seen);
  return {
    x: parentPosition.x + node.position.x,
    y: parentPosition.y + node.position.y,
  };
}

function allocateRemovedEdgeId(
  sourceId: string,
  allocatedIds: Set<string>
): string {
  const prefix = `comparison:removed:${sourceId}`;
  let candidate = prefix;
  let suffix = 1;
  while (allocatedIds.has(candidate)) {
    candidate = `${prefix}:${suffix}`;
    suffix += 1;
  }
  allocatedIds.add(candidate);
  return candidate;
}

const displayGraphCache = new WeakMap<
  WorkflowComparisonPayload,
  {
    positionOverrides: ComparisonPositionOverrides;
    removedNodeIndexes: ReadonlyMap<
      string,
      { index: number; defaultPosition: XYPosition }
    >;
    staticGraph: ComparisonDisplayGraph;
    graph: ComparisonDisplayGraph;
  }
>();

function applyPositionOverrides(
  cached: NonNullable<ReturnType<typeof displayGraphCache.get>>,
  positionOverrides: ComparisonPositionOverrides
): ComparisonDisplayGraph {
  let nodes = cached.graph.nodes;
  for (const [
    nodeId,
    { index, defaultPosition },
  ] of cached.removedNodeIndexes) {
    const position = positionOverrides[nodeId] ?? defaultPosition;
    const current = cached.graph.nodes[index];
    if (
      current &&
      (current.position.x !== position.x || current.position.y !== position.y)
    ) {
      if (nodes === cached.graph.nodes) {
        nodes = nodes.slice();
      }
      const staticNode = cached.staticGraph.nodes[index];
      if (staticNode) {
        nodes[index] =
          position.x === defaultPosition.x && position.y === defaultPosition.y
            ? staticNode
            : { ...staticNode, position };
      }
    }
  }

  cached.positionOverrides = positionOverrides;
  if (nodes !== cached.graph.nodes) {
    cached.graph = { nodes, edges: cached.staticGraph.edges };
  }
  return cached.graph;
}

/**
 * Produces a canvas graph from the redacted base and draft snapshots.
 *
 * Positions never determine a change marker. The server owns that decision in
 * `nodeChanges` and `edgeChanges`, which keeps a position-only draft clean.
 */
export function buildComparisonDisplayGraph(
  payload: WorkflowComparisonPayload,
  positionOverrides: ComparisonPositionOverrides = {}
): ComparisonDisplayGraph {
  const cached = displayGraphCache.get(payload);
  if (cached?.positionOverrides === positionOverrides) {
    return cached.graph;
  }
  if (cached) {
    return applyPositionOverrides(cached, positionOverrides);
  }

  const base = toWorkflowGraphData(payload.baseGraph);
  const draft = toWorkflowGraphData(payload.draftGraph);
  const baseNodes = base.nodes.map(toEditorNode);
  const draftNodes = draft.nodes.map(toEditorNode);
  const baseNodesById = new Map(baseNodes.map((node) => [node.id, node]));
  const draftNodeIds = new Set(draftNodes.map((node) => node.id));
  const nodeAnnotations = new Map<string, ComparisonNodeAnnotation>();
  for (const change of payload.nodeChanges) {
    nodeAnnotations.set(change.nodeId, { kind: change.kind });
  }

  const comparisonNodes = orderGroupParentsFirst([
    ...draftNodes.map<WorkflowNode>((node) => {
      const comparison = nodeAnnotations.get(node.id);
      return {
        ...node,
        draggable: false,
        connectable: false,
        focusable: false,
        deletable: false,
        data: {
          ...node.data,
          [COMPARISON_NODE_ANNOTATION]: comparison,
        },
      };
    }),
    ...baseNodes
      .filter((node) => !draftNodeIds.has(node.id))
      .map<WorkflowNode>((node) => {
        const comparison = nodeAnnotations.get(node.id);
        const historicalParentDeleted = Boolean(
          node.parentId &&
          baseNodesById.has(node.parentId) &&
          !draftNodeIds.has(node.parentId)
        );
        const position = historicalParentDeleted
          ? node.position
          : absoluteBasePosition(node, baseNodesById);
        const historical: WorkflowNode = {
          ...omit(node, ["parentId", "extent"]),
          position,
          draggable: true,
          connectable: false,
          focusable: true,
          deletable: false,
          data: {
            ...node.data,
            [COMPARISON_NODE_ANNOTATION]: comparison,
          },
        };
        // A deleted frame remains the coordinate system for its deleted
        // children. A current or missing frame cannot safely own history, so
        // the node carries neither key at all.
        if (historicalParentDeleted && node.parentId !== undefined) {
          historical.parentId = node.parentId;
          historical.extent = "parent";
        }
        return historical;
      }),
  ]);

  const baseEdges = base.edges.map(toEditorEdge);
  const draftEdges = draft.edges.map(toEditorEdge);
  const baseEdgesById = new Map(baseEdges.map((edge) => [edge.id, edge]));
  const draftEdgesById = new Map(draftEdges.map((edge) => [edge.id, edge]));
  const addedEdgeIds = new Set<string>();
  const removedEdgeIds = new Set<string>();
  for (const change of payload.edgeChanges) {
    (change.kind === "added" ? addedEdgeIds : removedEdgeIds).add(
      change.edgeId
    );
  }

  // Reserve every source id before allocating display ids. A real id may use
  // the same prefix as comparison chrome, including one from another edge.
  const allocatedIds = new Set([
    ...baseEdgesById.keys(),
    ...draftEdgesById.keys(),
  ]);
  const emittedIds = new Set<string>();
  const comparisonEdges: WorkflowEdge[] = draftEdges.map((edge) => {
    emittedIds.add(edge.id);
    const comparison: ComparisonEdgeAnnotation | undefined = addedEdgeIds.has(
      edge.id
    )
      ? { kind: "added", sourceId: edge.id }
      : undefined;
    return {
      ...edge,
      focusable: false,
      deletable: false,
      data: {
        ...edge.data,
        [COMPARISON_EDGE_ANNOTATION]: comparison,
      },
    };
  });
  for (const edgeId of removedEdgeIds) {
    const edge = baseEdgesById.get(edgeId);
    if (!edge) {
      continue;
    }
    const displayId = emittedIds.has(edge.id)
      ? allocateRemovedEdgeId(edge.id, allocatedIds)
      : edge.id;
    emittedIds.add(displayId);
    comparisonEdges.push({
      ...edge,
      id: displayId,
      focusable: false,
      deletable: false,
      data: {
        ...edge.data,
        [COMPARISON_EDGE_ANNOTATION]: {
          kind: "removed",
          sourceId: edge.id,
        },
      },
    });
  }

  const staticGraph: ComparisonDisplayGraph = {
    nodes: comparisonNodes,
    edges: comparisonEdges,
  };
  const removedNodeIndexes = new Map<
    string,
    { index: number; defaultPosition: XYPosition }
  >();
  for (const [index, node] of comparisonNodes.entries()) {
    if (!draftNodeIds.has(node.id)) {
      removedNodeIndexes.set(node.id, {
        index,
        defaultPosition: node.position,
      });
    }
  }
  const entry = {
    positionOverrides: {},
    removedNodeIndexes,
    staticGraph,
    graph: staticGraph,
  };
  displayGraphCache.set(payload, entry);
  return applyPositionOverrides(entry, positionOverrides);
}
