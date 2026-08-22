import type { Connection, Edge } from "@xyflow/react";
import { andJoinRefusalReason } from "@wfgraph/shared/graph/and-join";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { fanOutStoreEdges } from "@wfgraph/shared/graph/node-group";
import { normalizeSourceHandleForConnection } from "#src/components/workflow/connection-handle";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export function connectionHandleTypesMatch(
  from: "source" | "target",
  to: "source" | "target"
): boolean {
  return from !== to;
}

/** Explain a refused canvas connection, or return null when it can be saved. */
export function connectionRefusalReason({
  connection,
  nodes,
  edges,
  storeEdges,
  catalog,
}: {
  connection: Connection | Edge;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  storeEdges: WorkflowEdge[];
  catalog: ExtensionCatalog;
}): string | null {
  const sourceNodeId = connection.source;
  const targetNodeId = connection.target;

  if (!(sourceNodeId && targetNodeId)) {
    return "Choose both steps before creating the connection.";
  }
  if (sourceNodeId === targetNodeId) {
    return "Connect this step to a different step.";
  }

  const sourceNode = nodes.find((node) => node.id === sourceNodeId);
  const targetNode = nodes.find((node) => node.id === targetNodeId);
  if (sourceNode?.type === "add" || targetNode?.type === "add") {
    return "Connect to a workflow step rather than the Add step control.";
  }
  if (targetNode?.data.type === "lifecycle") {
    return "Lifecycle is the workflow entry and cannot accept a connection.";
  }
  if (sourceNode?.parentId || targetNode?.parentId) {
    return "Connect the Group frame rather than a step inside the Group.";
  }

  const connectionId =
    "id" in connection && typeof connection.id === "string"
      ? connection.id
      : null;
  const sourceHandle = normalizeSourceHandleForConnection({
    nodes,
    edges,
    sourceNodeId,
    sourceHandle: connection.sourceHandle,
    catalog,
  });
  const additions = fanOutStoreEdges({
    nodes,
    edges: storeEdges,
    sourceId: sourceNodeId,
    targetId: targetNodeId,
    sourceHandle,
    excludeEdgeId: connectionId,
  });
  if (additions.length === 0) {
    return "These steps are already connected from this outlet.";
  }

  return andJoinRefusalReason({
    nodes,
    edges: [
      ...storeEdges.filter((edge) => edge.id !== connectionId),
      ...additions,
    ],
  });
}
