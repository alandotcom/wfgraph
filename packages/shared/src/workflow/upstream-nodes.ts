/**
 * Which nodes a run passed through before it could reach a given node.
 *
 * One walk, because two would drift: the editor lists what a node can reference
 * from upstream, and the entry node's own answer depends on which of its outlets
 * lie on such a path. Both questions are this set.
 */

import type { WorkflowEdge } from "#src/workflow/types";

/**
 * The ids of every node with a path forward to `targetNodeId`, the target itself
 * excluded.
 *
 * Edges are followed backwards from the target, and a node already seen is not
 * walked again, so a cycle terminates: saving refuses a cyclic graph, and this
 * runs during render against whatever the canvas currently holds.
 */
export function upstreamNodeIds(
  targetNodeId: string,
  edges: readonly WorkflowEdge[]
): Set<string> {
  const sourcesByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    const sources = sourcesByTarget.get(edge.target);
    if (sources) {
      sources.push(edge.source);
    } else {
      sourcesByTarget.set(edge.target, [edge.source]);
    }
  }

  const upstream = new Set<string>();
  const visited = new Set<string>([targetNodeId]);
  const pending = [targetNodeId];

  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId) {
      continue;
    }

    for (const source of sourcesByTarget.get(nodeId) ?? []) {
      upstream.add(source);
      if (!visited.has(source)) {
        visited.add(source);
        pending.push(source);
      }
    }
  }

  return upstream;
}
