import { compact } from "es-toolkit/array";
import { enabledActionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  type LifecycleRules,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalInput, EvalNodeSelector } from "#src/agent/types";

export type SemanticsContext = {
  input: AgentEvalInput;
  document: AgentEvalDocument;
  /** The number of enabled nodes for every action id in the graph. */
  actionCounts: ReadonlyMap<string, number>;
  /** The nodes of the graph under assessment, keyed by node id. */
  nodeById: ReadonlyMap<string, WorkflowNode>;
  targetsBySource: ReadonlyMap<string, string[]>;
  /** The Lifecycle Rules from every enabled lifecycle node in document order. */
  lifecycleRules: readonly (LifecycleRules | undefined)[];
  lifecycleIds: readonly string[];
};

export function isEnabledNode(
  node: WorkflowNode | undefined
): node is WorkflowNode {
  return node !== undefined && node.data.enabled !== false;
}

export function matchesSelector(
  node: WorkflowNode | undefined,
  selector: EvalNodeSelector
): boolean {
  if (!isEnabledNode(node)) {
    return false;
  }
  if (selector.kind === "lifecycle") {
    return node.data.type === "lifecycle";
  }
  return (
    enabledActionTypeOf(node) === selector.actionId &&
    (selector.label === undefined || node.data.label === selector.label)
  );
}

export function selectorName(selector: EvalNodeSelector): string {
  if (selector.kind === "lifecycle") {
    return "lifecycle";
  }
  return selector.label ?? selector.actionId;
}

/**
 * Builds one-hop targets for enabled source nodes. A Map keeps arbitrary node
 * ids such as `constructor` separate from object prototype members.
 */
export function adjacency(input: {
  edges: readonly AgentEvalDocument["edges"][number][];
  nodeById: ReadonlyMap<string, WorkflowNode>;
}): ReadonlyMap<string, string[]> {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of input.edges) {
    if (!isEnabledNode(input.nodeById.get(edge.source))) {
      continue;
    }
    const targets = targetsBySource.get(edge.source);
    if (targets) {
      targets.push(edge.target);
    } else {
      targetsBySource.set(edge.source, [edge.target]);
    }
  }
  return targetsBySource;
}

/** Returns every node id reachable from the source ids, including each source. */
export function reachableNodeIds(input: {
  sourceIds: readonly string[];
  targetsBySource: ReadonlyMap<string, string[]>;
}): Set<string> {
  const reached = new Set(input.sourceIds);
  const pending = input.sourceIds.flatMap(
    (sourceId) => input.targetsBySource.get(sourceId) ?? []
  );
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (nodeId === undefined || reached.has(nodeId)) {
      continue;
    }
    reached.add(nodeId);
    pending.push(...(input.targetsBySource.get(nodeId) ?? []));
  }
  return reached;
}

export function nodesMatching(
  context: SemanticsContext,
  selector: EvalNodeSelector
): WorkflowNode[] {
  return context.document.nodes.filter((node) =>
    matchesSelector(node, selector)
  );
}

export function nodeIdsMatching(
  context: SemanticsContext,
  selector: EvalNodeSelector
): string[] {
  return nodesMatching(context, selector).map((node) => node.id);
}

/** True when a selected source reaches a selected target through one or more edges. */
export function hasPath(
  context: SemanticsContext,
  required: { source: EvalNodeSelector; target: EvalNodeSelector }
): boolean {
  const targetIds = nodeIdsMatching(context, required.target);

  // The walk starts at each source's targets. A source reaches itself only when
  // the graph contains a cycle back to the source.
  return nodeIdsMatching(context, required.source).some((sourceId) => {
    const downstream = reachableNodeIds({
      sourceIds: context.targetsBySource.get(sourceId) ?? [],
      targetsBySource: context.targetsBySource,
    });
    return targetIds.some((targetId) => downstream.has(targetId));
  });
}

/**
 * Applies a requirement to selected nodes. `allMatches` requires at least one
 * match and requires every match to pass.
 */
export function nodesSatisfy(
  context: SemanticsContext,
  required: { node: EvalNodeSelector; allMatches?: boolean | undefined },
  predicate: (node: WorkflowNode) => boolean
): boolean {
  const nodes = nodesMatching(context, required.node);
  return required.allMatches
    ? nodes.length > 0 && nodes.every(predicate)
    : nodes.some(predicate);
}

export function checkEach<Requirement>(
  requirements: readonly Requirement[] | undefined,
  check: (requirement: Requirement) => string | undefined
): string[] {
  return compact((requirements ?? []).map(check));
}

export function createSemanticsContext(
  input: AgentEvalInput,
  document: AgentEvalDocument
): SemanticsContext {
  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  const lifecycleNodes = document.nodes.filter(
    (node) => isEnabledNode(node) && node.data.type === "lifecycle"
  );

  return {
    input,
    document,
    actionCounts: document.nodes.reduce((counts, node) => {
      const actionId = enabledActionTypeOf(node);
      if (actionId !== undefined) {
        counts.set(actionId, (counts.get(actionId) ?? 0) + 1);
      }
      return counts;
    }, new Map<string, number>()),
    nodeById,
    targetsBySource: adjacency({ edges: document.edges, nodeById }),
    lifecycleRules: lifecycleNodes.map((node) =>
      readLifecycleRules(node.data.config)
    ),
    lifecycleIds: lifecycleNodes.map((node) => node.id),
  };
}
