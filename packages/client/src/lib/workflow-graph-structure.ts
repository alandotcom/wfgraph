/**
 * Facts about a graph's structure that navigation reads: a key that changes
 * only when nodes, their kinds and parents, or edge ids change, and the step an
 * older link to a Group lands on. Every function is pure.
 */

import { minBy } from "es-toolkit/array";
import { isGroupNode } from "@wfgraph/shared/graph/group-boundary";
import type { NavigationGraph } from "#src/lib/workflow-navigation-state";

/** Node ids, kinds, and parents plus edge ids: the facts recovery reads. */
export function graphStructureKey(graph: NavigationGraph): string {
  const nodes = graph.nodes
    .map((node) => `${node.id}:${node.data.type}:${node.parentId ?? ""}`)
    .join(",");
  return `${nodes}|${graph.edges.map((edge) => edge.id).join(",")}`;
}

/**
 * The step an older link naming the Group `groupId` selects: the member with
 * the lowest step number, or the first member the graph lists when none is
 * numbered. Null when the graph holds no such Group or the Group no member.
 */
export function firstStepOfGroup(input: {
  graph: NavigationGraph;
  groupId: string;
  stepNumbers: ReadonlyMap<string, number>;
}): string | null {
  const { graph, groupId } = input;
  if (!graph.nodes.some((node) => node.id === groupId && isGroupNode(node))) {
    return null;
  }
  const members = graph.nodes.filter((node) => node.parentId === groupId);
  const numbered = members.filter((node) => input.stepNumbers.has(node.id));
  const first =
    minBy(numbered, (node) => input.stepNumbers.get(node.id) ?? 0) ??
    members[0];
  return first?.id ?? null;
}
