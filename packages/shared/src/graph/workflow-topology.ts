import {
  isConditionActionNode,
  normalizeConditionBranch,
} from "#src/conditions/condition-branch";
import { andJoinRefusalReason } from "#src/graph/and-join";
import type { WorkflowEdge, WorkflowNode } from "#src/graph/types";
import { upstreamNodeIds } from "#src/graph/upstream-nodes";
import { isLifecycleOutlet } from "#src/lifecycle/lifecycle-outlets";

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function hasCycle(edges: readonly WorkflowEdge[]): boolean {
  return edges.some((edge) =>
    upstreamNodeIds(edge.source, edges).has(edge.target)
  );
}

function nodeLabel(node: WorkflowNode): string {
  return node.data.label?.trim() || node.id;
}

function conditionBranchRefusal(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): string | null {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));

  for (const edge of input.edges) {
    const sourceNode = nodeById.get(edge.source);
    if (!sourceNode) {
      continue;
    }

    const branch = normalizeConditionBranch(edge.sourceHandle);
    if (isConditionActionNode(sourceNode)) {
      if (edge.sourceHandle !== "true" && edge.sourceHandle !== "false") {
        return `Condition node "${nodeLabel(sourceNode)}" has edge "${edge.id}" without explicit sourceHandle "true" or "false"`;
      }
      continue;
    }

    if (branch) {
      return `Only Condition nodes can emit true/false branch edges (edge "${edge.id}")`;
    }
  }

  return null;
}

function lifecycleOutletRefusal(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): string | null {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));

  for (const edge of input.edges) {
    if (
      nodeById.get(edge.source)?.data.type === "lifecycle" &&
      !isLifecycleOutlet(edge.sourceHandle)
    ) {
      return `Edge "${edge.id}" leaves the Lifecycle Node without naming an outlet. Redraw it from the "Started" or "Canceled" handle.`;
    }
  }

  return null;
}

/**
 * Returns the first structural reason a draft cannot be saved.
 *
 * Wire decoding stays with the caller. This policy accepts the graph types used
 * by the editor, agent, and persistence service so each boundary makes the same
 * topology decision.
 */
export function workflowTopologyRefusalReason(input: {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
}): string | null {
  if (hasDuplicates(input.nodes.map((node) => node.id))) {
    return "Graph contains duplicate node IDs";
  }
  if (hasDuplicates(input.edges.map((edge) => edge.id))) {
    return "Graph contains duplicate edge IDs";
  }

  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const targetsBySource = new Map<string, Set<string>>();
  for (const edge of input.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return "Graph contains edges with missing source/target nodes";
    }
    if (edge.source === edge.target) {
      return "Graph cannot contain self-loops";
    }

    const targets = targetsBySource.get(edge.source) ?? new Set<string>();
    if (targets.has(edge.target)) {
      return "Graph cannot contain parallel edges between the same nodes";
    }
    targets.add(edge.target);
    targetsBySource.set(edge.source, targets);
  }

  if (hasCycle(input.edges)) {
    return "Graph must be acyclic";
  }

  const lifecycleNodes = input.nodes.filter(
    (node) => node.data.type === "lifecycle"
  );
  if (lifecycleNodes.length === 0) {
    return "Workflow must contain at least one Lifecycle Node";
  }

  const incoming = new Set(input.edges.map((edge) => edge.target));
  if (!lifecycleNodes.some((node) => !incoming.has(node.id))) {
    return "Workflow must contain at least one root Lifecycle Node";
  }

  return (
    conditionBranchRefusal(input) ??
    lifecycleOutletRefusal(input) ??
    andJoinRefusalReason(input)
  );
}
