import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { AgentEvalDocument } from "#src/agent/result";
import type { AgentEvalInput, EvalNodeSelector } from "#src/agent/types";
import type { DeterministicAssessment } from "#src/agent/judges/graph";

function matchesSelector(
  node: WorkflowNode | undefined,
  selector: EvalNodeSelector
): boolean {
  if (!node) {
    return false;
  }
  if (selector.kind === "lifecycle") {
    return node.data.type === "lifecycle";
  }
  return (
    actionTypeOf(node) === selector.actionId &&
    (selector.label === undefined || node.data.label === selector.label)
  );
}

function selectorName(selector: EvalNodeSelector): string {
  if (selector.kind === "lifecycle") {
    return "lifecycle";
  }
  return selector.label ?? selector.actionId;
}

function hasPath(input: {
  source: EvalNodeSelector;
  target: EvalNodeSelector;
  document: AgentEvalDocument;
}): boolean {
  const sourceIds = input.document.nodes
    .filter((node) => matchesSelector(node, input.source))
    .map((node) => node.id);
  const targetIds = new Set(
    input.document.nodes
      .filter((node) => matchesSelector(node, input.target))
      .map((node) => node.id)
  );
  const targetsBySource = new Map<string, string[]>();
  for (const edge of input.document.edges) {
    const targets = targetsBySource.get(edge.source);
    if (targets) {
      targets.push(edge.target);
    } else {
      targetsBySource.set(edge.source, [edge.target]);
    }
  }

  for (const sourceId of sourceIds) {
    const pending = [...(targetsBySource.get(sourceId) ?? [])];
    const visited = new Set([sourceId]);
    while (pending.length > 0) {
      const nodeId = pending.shift();
      if (nodeId === undefined || visited.has(nodeId)) {
        continue;
      }
      if (targetIds.has(nodeId)) {
        return true;
      }
      visited.add(nodeId);
      pending.push(...(targetsBySource.get(nodeId) ?? []));
    }
  }
  return false;
}

/** Checks the graph facts a scenario declares, allowing other valid graph details. */
export function assessScenarioSemantics(
  input: AgentEvalInput,
  document: AgentEvalDocument
): DeterministicAssessment {
  const issues: string[] = [];
  const actionIds = document.nodes.map(actionTypeOf);

  for (const [actionId, expectedCount] of Object.entries(
    input.expected.requiredActions ?? {}
  )) {
    const actualCount = actionIds.filter(
      (candidate) => candidate === actionId
    ).length;
    if (actualCount < expectedCount) {
      issues.push(
        `Expected ${expectedCount} ${actionId} node${expectedCount === 1 ? "" : "s"}, found ${actualCount}`
      );
    }
  }

  for (const actionId of input.expected.forbiddenActions ?? []) {
    if (actionIds.includes(actionId)) {
      issues.push(`forbidden action ${actionId} is present`);
    }
  }

  const lifecycle = document.nodes.find(
    (node) => node.data.type === "lifecycle"
  );
  const rules = readLifecycleRules(lifecycle?.data.config);
  for (const event of input.expected.startEvents ?? []) {
    if (!rules?.startEvents.includes(event)) {
      issues.push(`missing Start Event ${event}`);
    }
  }
  for (const event of input.expected.cancelEvents ?? []) {
    if (!rules?.cancelEvents.includes(event)) {
      issues.push(`missing Cancel Event ${event}`);
    }
  }

  const nodeById = new Map(document.nodes.map((node) => [node.id, node]));
  for (const flow of input.expected.requiredFlows ?? []) {
    const found = document.edges.some(
      (edge) =>
        matchesSelector(nodeById.get(edge.source), flow.source) &&
        matchesSelector(nodeById.get(edge.target), flow.target) &&
        (flow.sourceHandle === undefined ||
          edge.sourceHandle === flow.sourceHandle)
    );
    if (!found) {
      issues.push(
        `missing required flow ${selectorName(flow.source)} -> ${selectorName(flow.target)}${flow.sourceHandle === undefined ? "" : ` through ${flow.sourceHandle}`}`
      );
    }
  }

  for (const path of input.expected.requiredPaths ?? []) {
    if (!hasPath({ ...path, document })) {
      issues.push(
        `missing required path ${selectorName(path.source)} -> ${selectorName(path.target)}`
      );
    }
  }

  const initialById = new Map(
    input.document.nodes.map((node) => [node.id, node.data])
  );
  for (const nodeId of input.expected.preserveNodeIds ?? []) {
    const initial = initialById.get(nodeId);
    const final = nodeById.get(nodeId)?.data;
    if (
      initial === undefined ||
      JSON.stringify(initial) !== JSON.stringify(final)
    ) {
      issues.push(`node ${nodeId} was not preserved`);
    }
  }

  return issues.length === 0
    ? {
        score: 1,
        rationale: "The graph satisfies the scenario constraints.",
      }
    : { score: 0, rationale: `${issues.join("; ")}.` };
}
