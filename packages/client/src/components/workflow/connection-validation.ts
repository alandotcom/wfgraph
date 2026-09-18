import { andJoinRefusalReason } from "@wfgraph/shared/graph/and-join";
import type { ExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  analyzeGroupBoundaryById,
  isGroupNode,
} from "@wfgraph/shared/graph/group-boundary";
import {
  addedContinuationRefusal,
  addedIngressSourceRefusal,
  addedJoinRuleRefusal,
} from "@wfgraph/shared/graph/group-contract";
import {
  fanOutStoreEdges,
  groupOutlet,
} from "@wfgraph/shared/graph/node-group";
import { upstreamNodeIdsOver } from "@wfgraph/shared/graph/upstream-nodes";
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

function endpointRefusal(
  source: WorkflowNode | undefined,
  target: WorkflowNode | undefined
): string | null {
  if (source?.type === "add" || target?.type === "add")
    return "Connect to a workflow step rather than the Add step control.";
  if (target?.data.type === "lifecycle")
    return "Lifecycle is the workflow entry and cannot accept a connection.";
  return null;
}

/**
 * Resolve handles and collapsed Group ports without validating a partial graph.
 * Focused stubs must first pass through `storedCanvasConnection` and set
 * `throughBoundaryStub`. Callers validate the complete additions before storing.
 */
export function expandConnection({
  connection,
  throughBoundaryStub = false,
  nodes,
  storeEdges,
  catalog,
}: {
  connection: RequestedConnection;
  throughBoundaryStub?: boolean | undefined;
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
  const refusal = endpointRefusal(sourceNode, targetNode);
  if (refusal !== null) return { refusal };
  // A focused Group canvas paints members under their stored ids, so a
  // connection there between two members is stored as an interior edge. Any
  // other connection between a member and a step outside its Group goes through
  // the Group's collapsed card on the overview.
  if (
    !throughBoundaryStub &&
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
    if (
      sourceNode &&
      isGroupNode(sourceNode) &&
      groupOutlet(nodes, storeEdges, sourceNodeId).ports.length === 0
    ) {
      return {
        refusal: "Open this Group and connect the branch you want to continue.",
      };
    }
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

  return { additions };
}

/** Validate all additions together, so replacements never expose partial joins. */
export function connectionAdditionsRefusal(input: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  additions: ConnectionAddition[];
}): string | null {
  const { nodes, edges: remaining, additions } = input;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of additions) {
    const refusal = endpointRefusal(
      byId.get(edge.source),
      byId.get(edge.target)
    );
    if (refusal !== null) return refusal;
  }
  const proposedEdges = [...remaining, ...additions];
  const upstreamOf = upstreamNodeIdsOver(proposedEdges);
  if (additions.some((edge) => upstreamOf(edge.source).has(edge.target))) {
    return "This connection would create a cycle. Connect to a step that does not lead back here.";
  }
  return (
    addedIngressSourceRefusal({ nodes, edges: remaining, additions }) ??
    addedContinuationRefusal({ nodes, edges: remaining, additions }) ??
    andJoinRefusalReason({ nodes, edges: proposedEdges }) ??
    addedJoinRuleRefusal({ nodes, edges: remaining, additions })
  );
}

/** Expand and validate a single gesture against the stored graph. */
export function planConnection(
  input: Parameters<typeof expandConnection>[0]
): ConnectionPlan {
  const plan = expandConnection(input);
  if ("refusal" in plan) return plan;
  const remaining = input.storeEdges.some(
    (edge) => edge.id === input.connection.id
  )
    ? input.storeEdges.filter((edge) => edge.id !== input.connection.id)
    : input.storeEdges;
  const refusal = connectionAdditionsRefusal({
    nodes: input.nodes,
    edges: remaining,
    additions: plan.additions,
  });
  return refusal === null ? plan : { refusal };
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
