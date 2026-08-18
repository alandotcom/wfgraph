/**
 * The downstream walk over a whole graph's edges.
 *
 * A node already seen is not walked again, so a cycle terminates. The result is
 * strict: a start node appears only when an edge leads back to it.
 */

import type { WorkflowEdge } from "#src/graph/types";

/** Every node an edge path leads to from any of `startIds`. */
export function descendantsOf(input: {
  startIds: Iterable<string>;
  edges: readonly WorkflowEdge[];
}): Set<string> {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of input.edges) {
    const targets = targetsBySource.get(edge.source);
    if (targets) {
      targets.push(edge.target);
    } else {
      targetsBySource.set(edge.source, [edge.target]);
    }
  }

  const pending: string[] = [];
  for (const startId of input.startIds) {
    pending.push(...(targetsBySource.get(startId) ?? []));
  }

  const below = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || below.has(nodeId)) {
      continue;
    }
    below.add(nodeId);
    pending.push(...(targetsBySource.get(nodeId) ?? []));
  }

  return below;
}
