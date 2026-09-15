/**
 * A Group's boundary, derived from membership and the stored edges. Every answer
 * is read off the edges that cross from a non-member to a member or back. A port
 * is a node id plus the handle an edge names on that node, `null` for none.
 */

import { groupBy, uniqBy } from "es-toolkit/array";

/** Node fields Group code reads; shared and editor nodes both satisfy it. */
export type GroupGraphNode = {
  id: string;
  parentId?: string | undefined;
  data: {
    type: string;
    label?: string | undefined;
    config?: Record<string, unknown> | undefined;
    enabled?: boolean | undefined;
  };
};

/** Whether a node is a Group frame, read from `data.type`. */
export function isGroupNode(
  node: { data: { type: string } } | undefined
): boolean {
  return node?.data.type === "group";
}

/** Edge fields the boundary reads; shared and editor edges both satisfy it. */
export type GroupBoundaryEdge = {
  source: string;
  target: string;
  sourceHandle?: string | null | undefined;
  targetHandle?: string | null | undefined;
};

export type GroupPort = {
  nodeId: string;
  handle: string | null;
};

export type GroupBoundary<E extends GroupBoundaryEdge> = {
  /** The member ids, in the order the caller gave them. */
  memberIds: string[];
  /** Stored edges whose source and target are both members. */
  interiorEdges: E[];
  /** Stored edges from a non-member onto a member. */
  ingressEdges: E[];
  /** Stored edges from a member onto a non-member. */
  continuationEdges: E[];
  /** Each distinct non-member source port of `ingressEdges`. */
  externalIngress: GroupPort[];
  /** Each distinct member target port of `ingressEdges`. */
  internalEntryPorts: GroupPort[];
  /** Each distinct member source port of `continuationEdges`. */
  internalContinuation: GroupPort[];
  /** Each distinct non-member target port of `continuationEdges`. */
  externalTargets: GroupPort[];
  /**
   * Members with no outgoing stored edge, where a path through the Group ends
   * inside it. A member with an unwired outlet beside a wired one is not listed.
   */
  terminalMemberIds: string[];
};

/**
 * Derives the boundary a set of member ids has in the stored edges. The members
 * can be a Group's children or a selection that is not grouped yet.
 */
export function analyzeGroupBoundary<E extends GroupBoundaryEdge>(input: {
  memberIds: readonly string[];
  edges: readonly E[];
}): GroupBoundary<E> {
  const memberIds = [...input.memberIds];
  const members = new Set(memberIds);

  const byCrossing = groupBy(input.edges, (edge) => crossingOf(members, edge));
  const interiorEdges = byCrossing.interior ?? [];
  const ingressEdges = byCrossing.ingress ?? [];
  const continuationEdges = byCrossing.continuation ?? [];
  const sourcesWithOutgoing = new Set(
    [...interiorEdges, ...continuationEdges].map((edge) => edge.source)
  );

  return {
    memberIds,
    interiorEdges,
    ingressEdges,
    continuationEdges,
    externalIngress: distinctPorts(ingressEdges.map(sourcePort)),
    internalEntryPorts: distinctPorts(ingressEdges.map(targetPort)),
    internalContinuation: distinctPorts(continuationEdges.map(sourcePort)),
    externalTargets: distinctPorts(continuationEdges.map(targetPort)),
    terminalMemberIds: memberIds.filter((id) => !sourcesWithOutgoing.has(id)),
  };
}

/**
 * `analyzeGroupBoundary` for the nodes whose `parentId` names `groupId`, in
 * graph order. A graph holding no member of that Group answers empty lists. An
 * edge between members of two different Groups is continuation for one and
 * ingress for the other.
 */
export function analyzeGroupBoundaryById<E extends GroupBoundaryEdge>(input: {
  nodes: readonly { id: string; parentId?: string | undefined }[];
  edges: readonly E[];
  groupId: string;
}): GroupBoundary<E> {
  return analyzeGroupBoundary({
    memberIds: input.nodes
      .filter((node) => node.parentId === input.groupId)
      .map((node) => node.id),
    edges: input.edges,
  });
}

/** Where an edge sits relative to one set of members. */
type EdgeCrossing = "interior" | "ingress" | "continuation" | "outside";

function crossingOf(
  members: ReadonlySet<string>,
  edge: GroupBoundaryEdge
): EdgeCrossing {
  const sourceInside = members.has(edge.source);
  const targetInside = members.has(edge.target);
  if (sourceInside) {
    return targetInside ? "interior" : "continuation";
  }
  return targetInside ? "ingress" : "outside";
}

function sourcePort(edge: GroupBoundaryEdge): GroupPort {
  return { nodeId: edge.source, handle: edge.sourceHandle ?? null };
}

function targetPort(edge: GroupBoundaryEdge): GroupPort {
  return { nodeId: edge.target, handle: edge.targetHandle ?? null };
}

function distinctPorts(ports: readonly GroupPort[]): GroupPort[] {
  return uniqBy(ports, (port) => `${port.nodeId}\0${port.handle ?? ""}`);
}
