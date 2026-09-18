import { andJoinRefusalReason } from "@wfgraph/shared/graph/and-join";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  analyzeGroupBoundaryById,
  isGroupNode,
} from "@wfgraph/shared/graph/group-boundary";
import { addedIngressSourceRefusal } from "@wfgraph/shared/graph/group-contract";
import { fanOutStoreEdges } from "@wfgraph/shared/graph/node-group";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { normalizeSourceHandleForConnection } from "#src/components/workflow/connection-handle";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

export function connectionHandleTypesMatch(
  from: "source" | "target",
  to: "source" | "target"
): boolean {
  return from !== to;
}

/** A connection a person asked for, named by stored node ids. */
export type RequestedConnection = {
  /** The id of an existing edge this connection replaces, if any. */
  id?: string | undefined;
  source: string | null;
  target: string | null;
  sourceHandle?: string | null | undefined;
  targetHandle?: string | null | undefined;
};

/** A stored edge a connection adds, before the store gives it an id. */
export type ConnectionAddition = Omit<WorkflowEdge, "id">;

/**
 * What storing a connection does: a refusal a person reads, or the stored edges
 * it adds. A connection onto a Group card adds one edge per entry the fan-out
 * reaches.
 */
export type ConnectionPlan =
  | { refusal: string }
  | { additions: ConnectionAddition[] };

/**
 * Plan a connection between stored nodes against one graph. The canvas plans
 * against the graph it paints to preview a drag, and `connectNodesAtom` plans
 * again against the store when the drag ends and stores the additions, so the
 * two apply the same rules. A painted connection on a focused Group names
 * stubs, so the canvas passes it through `storedCanvasConnection` first.
 *
 * Two members of the same Group may connect. A member and a step outside its
 * Group connect only from an "Incoming from" stub, marked by `fromIngressStub`,
 * and a connection that would enter a Group from a second outside outlet is
 * `addedIngressSourceRefusal`'s to refuse. A join the draft save refuses is
 * `andJoinRefusalReason`'s. `storeEdges` are the stored edges, which name Group
 * members; the painted edges name frames and would give a Group outlet a
 * different handle.
 */
export function planConnection({
  connection,
  fromIngressStub = false,
  nodes,
  storeEdges,
  catalog,
}: {
  connection: RequestedConnection;
  fromIngressStub?: boolean | undefined;
  nodes: WorkflowNode[];
  storeEdges: WorkflowEdge[];
  catalog: ExtensionCatalog;
}): ConnectionPlan {
  const sourceNodeId = connection.source;
  const targetNodeId = connection.target;

  if (!(sourceNodeId && targetNodeId)) {
    return { refusal: "Choose both steps before creating the connection." };
  }
  if (sourceNodeId === targetNodeId) {
    return { refusal: "Connect this step to a different step." };
  }

  const sourceNode = nodes.find((node) => node.id === sourceNodeId);
  const targetNode = nodes.find((node) => node.id === targetNodeId);
  if (sourceNode?.type === "add" || targetNode?.type === "add") {
    return {
      refusal: "Connect to a workflow step rather than the Add step control.",
    };
  }
  if (targetNode?.data.type === "lifecycle") {
    return {
      refusal:
        "Lifecycle is the workflow entry and cannot accept a connection.",
    };
  }
  // A focused Group canvas paints members under their stored ids, so a
  // connection there between two members is stored as an interior edge. Any
  // other connection between a member and a step outside its Group goes through
  // the Group's collapsed card on the overview.
  if (
    !fromIngressStub &&
    (sourceNode?.parentId || targetNode?.parentId) &&
    sourceNode?.parentId !== targetNode?.parentId
  ) {
    return {
      refusal:
        "Connect two steps inside the same Group, or connect the Group card.",
    };
  }

  const connectionId = connection.id ?? null;
  const sourceHandle = normalizeSourceHandleForConnection({
    nodes,
    edges: storeEdges,
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
  }).map((item) =>
    // React Flow declares `sourceHandle` as optional, so a fan-out edge
    // leaving an unnamed handle omits it.
    omitUndefined({
      source: item.source,
      target: item.target,
      sourceHandle: item.sourceHandle,
      targetHandle: connection.targetHandle,
    })
  );
  if (additions.length === 0) {
    return {
      refusal: hasUnenteredMember({
        nodes,
        edges: storeEdges,
        node: targetNode,
      })
        ? 'This outlet already enters the Group. To connect it to another step inside, open the Group and drag from its "Incoming from" stub.'
        : "These steps are already connected from this outlet.",
    };
  }

  const remaining = storeEdges.filter((edge) => edge.id !== connectionId);
  const refusal =
    addedIngressSourceRefusal({ nodes, edges: remaining, additions }) ??
    andJoinRefusalReason({ nodes, edges: [...remaining, ...additions] });
  return refusal === null ? { additions } : { refusal };
}

/**
 * Explain a refused connection, or return null when `planConnection` would
 * store it.
 */
export function connectionRefusalReason(
  input: Parameters<typeof planConnection>[0]
): string | null {
  const plan = planConnection(input);
  return "refusal" in plan ? plan.refusal : null;
}

/**
 * Whether `node` is a Group holding a member no stored edge enters, which a
 * connection onto the collapsed card never reaches once the Group is entered.
 */
function hasUnenteredMember(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  node: WorkflowNode | undefined;
}): boolean {
  const { node } = input;
  if (node === undefined || !isGroupNode(node)) {
    return false;
  }
  const boundary = analyzeGroupBoundaryById({
    nodes: input.nodes,
    edges: input.edges,
    groupId: node.id,
  });
  const entered = new Set(
    [...boundary.interiorEdges, ...boundary.ingressEdges].map(
      (edge) => edge.target
    )
  );
  return boundary.memberIds.some((id) => !entered.has(id));
}
