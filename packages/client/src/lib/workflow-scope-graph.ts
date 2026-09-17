/**
 * Which workspace scope shows each part of a graph: the nodes and edges a scope
 * shows, the scope of one node or edge, and whether a focused Group still
 * exists. Every function is pure.
 */

import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import {
  scopeId,
  type NavigationGraph,
  type WorkspaceScope,
} from "#src/lib/workflow-navigation-state";

const OVERVIEW_SCOPE: WorkspaceScope = { kind: "overview" };

/**
 * The part of a graph one scope shows and can select. The overview holds every
 * node outside a Group frame and every edge. A Group scope holds that Group's
 * members and the stored edges entering a member, which are the interior and
 * ingress edges a focused Group lets a person select. Continuation edges are
 * display only there.
 */
export function graphInScope(
  graph: NavigationGraph,
  scope: WorkspaceScope
): NavigationGraph {
  if (scope.kind === "group") {
    const nodes = graph.nodes.filter((node) => node.parentId === scope.groupId);
    const memberIds = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: graph.edges.filter((edge) => memberIds.has(edge.target)),
    };
  }
  const groupIds = new Set(
    graph.nodes.filter((node) => isGroupNode(node)).map((node) => node.id)
  );
  const nodes = graph.nodes.filter(
    (node) => node.parentId === undefined || !groupIds.has(node.parentId)
  );
  return nodes.length === graph.nodes.length ? graph : { ...graph, nodes };
}

/**
 * The scope that shows `nodeId`: the focused canvas of the Group frame holding
 * it, or the overview for every other node, including one the graph lacks.
 */
export function scopeOfNode(
  nodes: NavigationGraph["nodes"],
  nodeId: string
): WorkspaceScope {
  const node = nodes.find((item) => item.id === nodeId);
  const parent =
    node?.parentId === undefined
      ? undefined
      : nodes.find((item) => item.id === node.parentId);
  return parent && isGroupNode(parent)
    ? { kind: "group", groupId: parent.id }
    : OVERVIEW_SCOPE;
}

/**
 * The scope that selects `edge`: the focused canvas of a Group when both ends
 * are members of that Group, and the overview for every other edge. The
 * overview hides an edge between two members of one Group.
 */
export function scopeOfEdge(
  nodes: NavigationGraph["nodes"],
  edge: { source: string; target: string }
): WorkspaceScope {
  const source = scopeOfNode(nodes, edge.source);
  return scopeId(source) === scopeId(scopeOfNode(nodes, edge.target))
    ? source
    : OVERVIEW_SCOPE;
}

/** Node ids, kinds, and parents plus edge ids: the facts recovery reads. */
export function graphStructureKey(graph: NavigationGraph): string {
  const nodes = graph.nodes
    .map((node) => `${node.id}:${node.data.type}:${node.parentId ?? ""}`)
    .join(",");
  return `${nodes}|${graph.edges.map((edge) => edge.id).join(",")}`;
}

/** Whether the presented graph still holds the Group a scope is focused on. */
export function groupScopeExists(
  scope: WorkspaceScope,
  graph: NavigationGraph
): boolean {
  return (
    scope.kind === "overview" ||
    graph.nodes.some((node) => node.id === scope.groupId && isGroupNode(node))
  );
}
