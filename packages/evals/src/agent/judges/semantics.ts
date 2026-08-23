import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { readLifecycleRules } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { readWaitSubscriptions } from "@wfgraph/shared/lifecycle/wait-subscription";
import { parseConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { parseDurationMs } from "@wfgraph/shared/utils/wait-time";
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

function reachableNodeIds(input: {
  sourceIds: readonly string[];
  document: AgentEvalDocument;
  includeEdge?: (edge: AgentEvalDocument["edges"][number]) => boolean;
}): Set<string> {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of input.document.edges) {
    if (input.includeEdge && !input.includeEdge(edge)) {
      continue;
    }
    const targets = targetsBySource.get(edge.source);
    if (targets) {
      targets.push(edge.target);
    } else {
      targetsBySource.set(edge.source, [edge.target]);
    }
  }

  const reached = new Set(input.sourceIds);
  const pending = input.sourceIds.flatMap(
    (sourceId) => targetsBySource.get(sourceId) ?? []
  );
  while (pending.length > 0) {
    const nodeId = pending.shift();
    if (nodeId === undefined || reached.has(nodeId)) {
      continue;
    }
    reached.add(nodeId);
    pending.push(...(targetsBySource.get(nodeId) ?? []));
  }
  return reached;
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

  for (const [actionId, expectedCount] of Object.entries(
    input.expected.exactActions ?? {}
  )) {
    const actualCount = actionIds.filter(
      (candidate) => candidate === actionId
    ).length;
    if (actualCount !== expectedCount) {
      issues.push(
        `Expected exactly ${expectedCount} ${actionId} node${expectedCount === 1 ? "" : "s"}, found ${actualCount}`
      );
    }
  }

  for (const actionId of input.expected.forbiddenActions ?? []) {
    if (actionIds.includes(actionId)) {
      issues.push(`forbidden action ${actionId} is present`);
    }
  }
  if (input.expected.allowedActions !== undefined) {
    const allowed = new Set(input.expected.allowedActions);
    const unexpected = actionIds.filter(
      (actionId): actionId is string =>
        actionId !== undefined && !allowed.has(actionId)
    );
    if (unexpected.length > 0) {
      issues.push(`unexpected action ${unexpected[0]} is present`);
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

  const lifecycleIds = document.nodes
    .filter((node) => node.data.type === "lifecycle")
    .map((node) => node.id);
  for (const required of input.expected.requiredGates ?? []) {
    const gateIds = new Set(
      document.nodes
        .filter((node) => matchesSelector(node, required.gate))
        .map((node) => node.id)
    );
    const targetIds = new Set(
      document.nodes
        .filter((node) => matchesSelector(node, required.target))
        .map((node) => node.id)
    );
    const gateEdges = document.edges.filter(
      (edge) =>
        gateIds.has(edge.source) && edge.sourceHandle === required.sourceHandle
    );
    const gatedReach = reachableNodeIds({
      sourceIds: gateEdges.map((edge) => edge.target),
      document,
    });
    const hasGatedPath = [...targetIds].some((nodeId) =>
      gatedReach.has(nodeId)
    );
    if (!hasGatedPath) {
      issues.push(
        `missing required gated path ${selectorName(required.gate)} -> ${selectorName(required.target)} through ${required.sourceHandle}`
      );
      continue;
    }

    const acceptedEdgeIds = new Set(gateEdges.map((edge) => edge.id));
    const reachWithoutGate = reachableNodeIds({
      sourceIds: lifecycleIds,
      document,
      includeEdge: (edge) => !acceptedEdgeIds.has(edge.id),
    });
    if ([...targetIds].some((nodeId) => reachWithoutGate.has(nodeId))) {
      issues.push(
        `a path to ${selectorName(required.target)} bypasses required gate ${selectorName(required.gate)} through ${required.sourceHandle}`
      );
    }
  }

  for (const required of input.expected.requiredParallel ?? []) {
    if (
      hasPath({
        source: required.first,
        target: required.second,
        document,
      }) ||
      hasPath({
        source: required.second,
        target: required.first,
        document,
      })
    ) {
      issues.push(
        `${selectorName(required.first)} and ${selectorName(required.second)} are not parallel branches`
      );
    }
  }

  for (const required of input.expected.requiredConfigs ?? []) {
    const matchingNodes = document.nodes.filter((node) =>
      matchesSelector(node, required.node)
    );
    const hasConfig = (node: WorkflowNode) =>
      Object.entries(required.values).every(
        ([key, value]) => node.data.config?.[key] === value
      );
    const satisfied = required.allMatches
      ? matchingNodes.length > 0 && matchingNodes.every(hasConfig)
      : matchingNodes.some(hasConfig);
    if (!satisfied) {
      issues.push(
        `${selectorName(required.node)} does not have required config ${Object.keys(required.values).join(", ")}`
      );
    }
  }

  for (const required of input.expected.requiredNonEmptyConfigs ?? []) {
    const matchingNodes = document.nodes.filter((node) =>
      matchesSelector(node, required.node)
    );
    const hasNonEmptyConfig = (node: WorkflowNode) =>
      required.keys.every((key) => {
        const value = node.data.config?.[key];
        return typeof value === "string"
          ? value.trim().length > 0
          : value !== undefined && value !== null;
      });
    const satisfied = required.allMatches
      ? matchingNodes.length > 0 && matchingNodes.every(hasNonEmptyConfig)
      : matchingNodes.some(hasNonEmptyConfig);
    if (!satisfied) {
      issues.push(
        `${selectorName(required.node)} has empty required config ${required.keys.join(", ")}`
      );
    }
  }

  for (const required of input.expected.requiredDurations ?? []) {
    const expectedMs = parseDurationMs(required.duration);
    const satisfied = document.nodes
      .filter((node) => matchesSelector(node, required.node))
      .some(
        (node) =>
          expectedMs !== null &&
          parseDurationMs(node.data.config?.[required.key]) === expectedMs
      );
    if (!satisfied) {
      issues.push(
        `${selectorName(required.node)} does not have required duration ${required.key}`
      );
    }
  }

  for (const required of input.expected.requiredWaitEvents ?? []) {
    const subscribed = new Set(
      document.nodes
        .filter((node) => matchesSelector(node, required.node))
        .flatMap((node) => readWaitSubscriptions(node.data.config))
        .map((subscription) => subscription.event)
    );
    const missing = required.events.filter((event) => !subscribed.has(event));
    if (missing.length > 0) {
      issues.push(
        `${selectorName(required.node)} is missing required Wait Event ${missing.join(", ")}`
      );
    } else if (required.exact && subscribed.size !== required.events.length) {
      issues.push(
        `${selectorName(required.node)} has unexpected Wait Event subscriptions`
      );
    }
  }

  for (const required of input.expected.requiredConditionRules ?? []) {
    const matchingNodes = document.nodes.filter((node) =>
      matchesSelector(node, required.node)
    );
    const found = matchingNodes.some((node) => {
      const parsed = parseConditionModel(node.data.config?.conditionModel);
      if (!parsed.valid) {
        return false;
      }
      return parsed.model.groups.some((group) =>
        group.conditions.some(
          (rule) =>
            rule.field === required.field &&
            rule.operator === required.operator &&
            (required.value === undefined ||
              ("value" in rule && rule.value === required.value))
        )
      );
    });
    if (!found) {
      issues.push(
        `${selectorName(required.node)} is missing required rule ${required.field} ${required.operator}${required.value === undefined ? "" : ` ${required.value}`}`
      );
    }
  }

  for (const required of input.expected.requiredConditionLogic ?? []) {
    const found = document.nodes
      .filter((node) => matchesSelector(node, required.node))
      .some((node) => {
        const parsed = parseConditionModel(node.data.config?.conditionModel);
        return (
          parsed.valid &&
          parsed.model.groupLogic === required.groupLogic &&
          (required.ruleLogic === undefined ||
            parsed.model.groups.every(
              (group) => group.logic === required.ruleLogic
            ))
        );
      });
    if (!found) {
      issues.push(
        `${selectorName(required.node)} does not use required ${required.groupLogic}/${required.ruleLogic ?? "any"} logic`
      );
    }
  }

  for (const required of input.expected.requiredReferences ?? []) {
    const matchingNodes = document.nodes.filter((node) =>
      matchesSelector(node, required.node)
    );
    const hasReference = (node: WorkflowNode) => {
      const value = node.data.config?.[required.key];
      if (typeof value !== "string") {
        return false;
      }
      return findTemplateTokens(value).some((token) => {
        if (token.fieldPath !== required.path) {
          return false;
        }
        const source = nodeById.get(token.nodeId);
        if (source?.data.type === "lifecycle") {
          return input.catalog.events.some((event) =>
            event.payloadFields.some((field) => field.path === required.path)
          );
        }
        const sourceAction = source ? actionTypeOf(source) : undefined;
        return (
          sourceAction !== undefined &&
          findAction(input.catalog, sourceAction)?.outputFields.some(
            (field) => field.path === required.path
          ) === true
        );
      });
    };
    const found = required.allMatches
      ? matchingNodes.length > 0 && matchingNodes.every(hasReference)
      : matchingNodes.some(hasReference);
    if (!found) {
      issues.push(
        `${selectorName(required.node)} ${required.key} does not reference ${required.path}`
      );
    }
  }

  for (const required of input.expected.distinctConfigValues ?? []) {
    const values = new Set(
      document.nodes
        .filter((node) => matchesSelector(node, required.nodes))
        .map((node) => node.data.config?.[required.key])
        .filter(
          (value): value is string | number | boolean =>
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        )
    );
    if (values.size !== required.count) {
      issues.push(
        `${selectorName(required.nodes)} needs ${required.count} distinct ${required.key} values, found ${values.size}`
      );
    }
  }

  const initialById = new Map(
    input.document.nodes.map((node) => [node.id, node.data])
  );
  if (
    input.expected.preserveDocument === true &&
    JSON.stringify(input.document) !== JSON.stringify(document)
  ) {
    issues.push("the workflow document changed");
  }
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
