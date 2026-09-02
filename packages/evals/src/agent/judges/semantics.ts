import { compact } from "es-toolkit/array";
import { actionTypeOf } from "@wfgraph/shared/graph/node-config";
import { findTemplateTokens } from "@wfgraph/shared/graph/node-references";
import { findAction } from "@wfgraph/shared/extensions/catalog";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import {
  type LifecycleRules,
  readLifecycleRules,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";
import { readWaitSubscriptions } from "@wfgraph/shared/lifecycle/wait-subscription";
import { parseConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { isBlank } from "@wfgraph/shared/types/string";
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

/**
 * The target node ids each source node reaches in one hop, keyed by source id.
 * A node with no outgoing edge is absent, so every read falls back to an empty
 * list.
 */
function adjacency(
  edges: readonly AgentEvalDocument["edges"][number][]
): ReadonlyMap<string, string[]> {
  // A Map rather than a record: a node id is arbitrary text, and a plain object
  // would answer `constructor` with a prototype member instead of undefined.
  const targetsBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = targetsBySource.get(edge.source);
    if (targets) {
      targets.push(edge.target);
    } else {
      targetsBySource.set(edge.source, [edge.target]);
    }
  }
  return targetsBySource;
}

/** Every node id these source nodes reach, the source ids included. */
function reachableNodeIds(input: {
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

/**
 * The document facts every rule reads, built once per assessment so that no
 * rule rebuilds a lookup another rule already holds.
 */
type SemanticsContext = {
  input: AgentEvalInput;
  document: AgentEvalDocument;
  /** The action id of each node in document order; a lifecycle node has none. */
  actionIds: readonly (string | undefined)[];
  /** The nodes of the graph under assessment, keyed by node id. */
  nodeById: ReadonlyMap<string, WorkflowNode>;
  /** The nodes of the document the agent started from, keyed by node id. */
  initialNodeById: ReadonlyMap<string, WorkflowNode>;
  targetsBySource: ReadonlyMap<string, string[]>;
  /** The Lifecycle Rules of the first lifecycle node, undefined when there is none. */
  lifecycleRules: LifecycleRules | undefined;
  lifecycleIds: readonly string[];
};

/** Reports the issues one check found, or undefined when the check passes. */
type SemanticsRule = (
  context: SemanticsContext
) => string | readonly string[] | undefined;

function nodesMatching(
  context: SemanticsContext,
  selector: EvalNodeSelector
): WorkflowNode[] {
  return context.document.nodes.filter((node) =>
    matchesSelector(node, selector)
  );
}

function nodeIdsMatching(
  context: SemanticsContext,
  selector: EvalNodeSelector
): string[] {
  return nodesMatching(context, selector).map((node) => node.id);
}

function countActions(context: SemanticsContext, actionId: string): number {
  return context.actionIds.filter((candidate) => candidate === actionId).length;
}

/** True when some source node reaches some target node over any number of edges. */
function hasPath(
  context: SemanticsContext,
  required: { source: EvalNodeSelector; target: EvalNodeSelector }
): boolean {
  const targetIds = nodeIdsMatching(context, required.target);

  // The walk starts at the source's own targets, so a node that matches both
  // selectors reaches itself only over a cycle.
  return nodeIdsMatching(context, required.source).some((sourceId) => {
    const downstream = reachableNodeIds({
      sourceIds: context.targetsBySource.get(sourceId) ?? [],
      targetsBySource: context.targetsBySource,
    });
    return targetIds.some((targetId) => downstream.has(targetId));
  });
}

/**
 * Applies a per-node requirement to the nodes a selector matched. With
 * `allMatches` every matched node must satisfy it and at least one node must
 * match; otherwise one satisfying node is enough.
 */
function nodesSatisfy(
  context: SemanticsContext,
  required: { node: EvalNodeSelector; allMatches?: boolean | undefined },
  predicate: (node: WorkflowNode) => boolean
): boolean {
  const nodes = nodesMatching(context, required.node);
  return required.allMatches
    ? nodes.length > 0 && nodes.every(predicate)
    : nodes.some(predicate);
}

/** The failures one check found over every requirement a scenario declared. */
function checkEach<Requirement>(
  requirements: readonly Requirement[] | undefined,
  check: (requirement: Requirement) => string | undefined
): string[] {
  return compact((requirements ?? []).map(check));
}

/** The pluralized node count both action-count checks report. */
function actionNodeCount(count: number, actionId: string): string {
  return `${count} ${actionId} node${count === 1 ? "" : "s"}`;
}

/** Each required action id appears at least as often as the scenario asks. */
function missingActions(context: SemanticsContext): string[] {
  return checkEach(
    Object.entries(context.input.expected.requiredActions ?? {}),
    ([actionId, expectedCount]) => {
      const actualCount = countActions(context, actionId);
      return actualCount < expectedCount
        ? `Expected ${actionNodeCount(expectedCount, actionId)}, found ${actualCount}`
        : undefined;
    }
  );
}

/** Each action id the scenario counts exactly appears exactly that often. */
function wrongExactActionCounts(context: SemanticsContext): string[] {
  return checkEach(
    Object.entries(context.input.expected.exactActions ?? {}),
    ([actionId, expectedCount]) => {
      const actualCount = countActions(context, actionId);
      return actualCount === expectedCount
        ? undefined
        : `Expected exactly ${actionNodeCount(expectedCount, actionId)}, found ${actualCount}`;
    }
  );
}

/** No forbidden action id appears in the graph. */
function forbiddenActions(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.forbiddenActions, (actionId) =>
    context.actionIds.includes(actionId)
      ? `forbidden action ${actionId} is present`
      : undefined
  );
}

/**
 * Every action id in the graph is on the allowed list. Only the first
 * disallowed action id is reported, since one wrong action explains the score.
 */
function disallowedActions(context: SemanticsContext): string | undefined {
  const allowedActions = context.input.expected.allowedActions;
  if (allowedActions === undefined) {
    return undefined;
  }
  const allowed = new Set(allowedActions);
  const unexpected = context.actionIds.filter(
    (actionId): actionId is string =>
      actionId !== undefined && !allowed.has(actionId)
  );
  return unexpected.length > 0
    ? `unexpected action ${unexpected[0]} is present`
    : undefined;
}

/** The Lifecycle Rules list every Start Event the scenario requires. */
function missingStartEvents(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.startEvents, (event) =>
    context.lifecycleRules?.startEvents.includes(event)
      ? undefined
      : `missing Start Event ${event}`
  );
}

/** The Lifecycle Rules list every Cancel Event the scenario requires. */
function missingCancelEvents(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.cancelEvents, (event) =>
    context.lifecycleRules?.cancelEvents.includes(event)
      ? undefined
      : `missing Cancel Event ${event}`
  );
}

/** Each required flow exists as one edge, on the named outlet when given. */
function missingFlows(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredFlows, (flow) => {
    const found = context.document.edges.some(
      (edge) =>
        matchesSelector(context.nodeById.get(edge.source), flow.source) &&
        matchesSelector(context.nodeById.get(edge.target), flow.target) &&
        (flow.sourceHandle === undefined ||
          edge.sourceHandle === flow.sourceHandle)
    );
    return found
      ? undefined
      : `missing required flow ${selectorName(flow.source)} -> ${selectorName(flow.target)}${flow.sourceHandle === undefined ? "" : ` through ${flow.sourceHandle}`}`;
  });
}

/** Each required path exists over any number of intermediate nodes. */
function missingPaths(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredPaths, (path) =>
    hasPath(context, path)
      ? undefined
      : `missing required path ${selectorName(path.source)} -> ${selectorName(path.target)}`
  );
}

/**
 * Each required gate reaches its target through the named outlet, and no other
 * route from a lifecycle node reaches that target around the gate. A gate that
 * fails the first check is reported once and not tested for a bypass.
 */
function gateFailures(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredGates, (required) => {
    const gateIds = new Set(nodeIdsMatching(context, required.gate));
    const targetIds = new Set(nodeIdsMatching(context, required.target));
    const gateEdges = context.document.edges.filter(
      (edge) =>
        gateIds.has(edge.source) && edge.sourceHandle === required.sourceHandle
    );
    const gatedReach = reachableNodeIds({
      sourceIds: gateEdges.map((edge) => edge.target),
      targetsBySource: context.targetsBySource,
    });
    const hasGatedPath = [...targetIds].some((nodeId) =>
      gatedReach.has(nodeId)
    );
    if (!hasGatedPath) {
      return `missing required gated path ${selectorName(required.gate)} -> ${selectorName(required.target)} through ${required.sourceHandle}`;
    }

    const acceptedEdgeIds = new Set(gateEdges.map((edge) => edge.id));
    const reachWithoutGate = reachableNodeIds({
      sourceIds: context.lifecycleIds,
      targetsBySource: adjacency(
        context.document.edges.filter((edge) => !acceptedEdgeIds.has(edge.id))
      ),
    });
    return [...targetIds].some((nodeId) => reachWithoutGate.has(nodeId))
      ? `a path to ${selectorName(required.target)} bypasses required gate ${selectorName(required.gate)} through ${required.sourceHandle}`
      : undefined;
  });
}

/** Neither node of a required parallel pair is downstream of the other. */
function nonParallelBranches(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredParallel, (required) =>
    hasPath(context, { source: required.first, target: required.second }) ||
    hasPath(context, { source: required.second, target: required.first })
      ? `${selectorName(required.first)} and ${selectorName(required.second)} are not parallel branches`
      : undefined
  );
}

/** Each required config key holds the exact value the scenario names. */
function missingConfigs(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredConfigs, (required) => {
    const hasConfig = (node: WorkflowNode) =>
      Object.entries(required.values).every(
        ([key, value]) => node.data.config?.[key] === value
      );
    return nodesSatisfy(context, required, hasConfig)
      ? undefined
      : `${selectorName(required.node)} does not have required config ${Object.keys(required.values).join(", ")}`;
  });
}

/** Each config key the scenario requires holds a value that is not blank. */
function emptyConfigs(context: SemanticsContext): string[] {
  return checkEach(
    context.input.expected.requiredNonEmptyConfigs,
    (required) => {
      const hasNonEmptyConfig = (node: WorkflowNode) =>
        required.keys.every((key) => {
          const value = node.data.config?.[key];
          return typeof value === "string"
            ? !isBlank(value)
            : value !== undefined && value !== null;
        });
      return nodesSatisfy(context, required, hasNonEmptyConfig)
        ? undefined
        : `${selectorName(required.node)} has empty required config ${required.keys.join(", ")}`;
    }
  );
}

/** Each required duration parses to the same number of milliseconds. */
function missingDurations(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredDurations, (required) => {
    const expectedMs = parseDurationMs(required.duration);
    const satisfied = nodesMatching(context, required.node).some(
      (node) =>
        expectedMs !== null &&
        parseDurationMs(node.data.config?.[required.key]) === expectedMs
    );
    return satisfied
      ? undefined
      : `${selectorName(required.node)} does not have required duration ${required.key}`;
  });
}

/**
 * Each required Wait node subscribes to every Event the scenario names, and to
 * no others when the scenario asks for an exact set.
 */
function missingWaitEvents(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredWaitEvents, (required) => {
    const subscribed = new Set(
      nodesMatching(context, required.node)
        .flatMap((node) => readWaitSubscriptions(node.data.config))
        .map((subscription) => subscription.event)
    );
    const missing = required.events.filter((event) => !subscribed.has(event));
    if (missing.length > 0) {
      return `${selectorName(required.node)} is missing required Wait Event ${missing.join(", ")}`;
    }
    return required.exact && subscribed.size !== required.events.length
      ? `${selectorName(required.node)} has unexpected Wait Event subscriptions`
      : undefined;
  });
}

/** Some Condition node carries each rule the scenario names. */
function missingConditionRules(context: SemanticsContext): string[] {
  return checkEach(
    context.input.expected.requiredConditionRules,
    (required) => {
      const found = nodesMatching(context, required.node).some((node) => {
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
      return found
        ? undefined
        : `${selectorName(required.node)} is missing required rule ${required.field} ${required.operator}${required.value === undefined ? "" : ` ${required.value}`}`;
    }
  );
}

/** Some Condition node combines its groups and rules with the required logic. */
function wrongConditionLogic(context: SemanticsContext): string[] {
  return checkEach(
    context.input.expected.requiredConditionLogic,
    (required) => {
      const found = nodesMatching(context, required.node).some((node) => {
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
      return found
        ? undefined
        : `${selectorName(required.node)} does not use required ${required.groupLogic}/${required.ruleLogic ?? "any"} logic`;
    }
  );
}

/**
 * Each required config key holds a template token for the named field path, and
 * the node the token reads from publishes that path in the catalog.
 */
function missingReferences(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.requiredReferences, (required) => {
    const hasReference = (node: WorkflowNode) => {
      const value = node.data.config?.[required.key];
      if (typeof value !== "string") {
        return false;
      }
      return findTemplateTokens(value).some((token) => {
        if (token.fieldPath !== required.path) {
          return false;
        }
        const source = context.nodeById.get(token.nodeId);
        if (source?.data.type === "lifecycle") {
          return context.input.catalog.events.some((event) =>
            event.payloadFields.some((field) => field.path === required.path)
          );
        }
        const sourceAction = source ? actionTypeOf(source) : undefined;
        return (
          sourceAction !== undefined &&
          findAction(context.input.catalog, sourceAction)?.outputFields.some(
            (field) => field.path === required.path
          ) === true
        );
      });
    };
    return nodesSatisfy(context, required, hasReference)
      ? undefined
      : `${selectorName(required.node)} ${required.key} does not reference ${required.path}`;
  });
}

/** The matched nodes hold as many distinct values for a config key as required. */
function wrongDistinctConfigValues(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.distinctConfigValues, (required) => {
    const values = new Set(
      nodesMatching(context, required.nodes)
        .map((node) => node.data.config?.[required.key])
        .filter(
          (value): value is string | number | boolean =>
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        )
    );
    return values.size === required.count
      ? undefined
      : `${selectorName(required.nodes)} needs ${required.count} distinct ${required.key} values, found ${values.size}`;
  });
}

/** A scenario the agent must refuse leaves the whole document untouched. */
function changedDocument(context: SemanticsContext): string | undefined {
  return context.input.expected.preserveDocument === true &&
    JSON.stringify(context.input.document) !== JSON.stringify(context.document)
    ? "the workflow document changed"
    : undefined;
}

/** Each node the scenario protects still holds the data it started with. */
function changedPreservedNodes(context: SemanticsContext): string[] {
  return checkEach(context.input.expected.preserveNodeIds, (nodeId) => {
    const initial = context.initialNodeById.get(nodeId)?.data;
    const final = context.nodeById.get(nodeId)?.data;
    return initial === undefined ||
      JSON.stringify(initial) !== JSON.stringify(final)
      ? `node ${nodeId} was not preserved`
      : undefined;
  });
}

/** The checks, in the order their messages appear in the rationale. */
const rules: readonly SemanticsRule[] = [
  missingActions,
  wrongExactActionCounts,
  forbiddenActions,
  disallowedActions,
  missingStartEvents,
  missingCancelEvents,
  missingFlows,
  missingPaths,
  gateFailures,
  nonParallelBranches,
  missingConfigs,
  emptyConfigs,
  missingDurations,
  missingWaitEvents,
  missingConditionRules,
  wrongConditionLogic,
  missingReferences,
  wrongDistinctConfigValues,
  changedDocument,
  changedPreservedNodes,
];

/** Checks the graph facts a scenario declares, allowing other valid graph details. */
export function assessScenarioSemantics(
  input: AgentEvalInput,
  document: AgentEvalDocument
): DeterministicAssessment {
  const lifecycleNodes = document.nodes.filter(
    (node) => node.data.type === "lifecycle"
  );
  const context: SemanticsContext = {
    input,
    document,
    actionIds: document.nodes.map(actionTypeOf),
    // Maps rather than keyBy records: a node id read out of a template token
    // is arbitrary text, and a plain object would answer `constructor` with a
    // prototype member instead of undefined.
    nodeById: new Map(document.nodes.map((node) => [node.id, node])),
    initialNodeById: new Map(
      input.document.nodes.map((node) => [node.id, node])
    ),
    targetsBySource: adjacency(document.edges),
    lifecycleRules: readLifecycleRules(lifecycleNodes[0]?.data.config),
    lifecycleIds: lifecycleNodes.map((node) => node.id),
  };

  const issues = compact(rules.flatMap((rule) => rule(context)));

  return issues.length === 0
    ? {
        score: 1,
        rationale: "The graph satisfies the scenario constraints.",
      }
    : { score: 0, rationale: `${issues.join("; ")}.` };
}
