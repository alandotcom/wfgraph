/**
 * What one recorded execution of a Condition decided, in the terms a person
 * reads it in: the branch its answer took, the steps that branch connects to
 * in the graph the run pinned, and for each rule whether it matched and the
 * value it compared, where the run's evidence holds them. Pure.
 *
 * A Condition's log row records only its answer, so each rule's value is read
 * from the records the engine read it from. A rule naming the Lifecycle Node
 * reads the payload of the branch's Arriving Event, as the engine does: the
 * Event that woke the nearest event-mode Wait above, else the Start Event. A
 * rule's verdict comes from the answer where the logic decides it, and else
 * from comparing its value, kept only where the verdicts agree with the answer.
 */

import { normalizeConditionBranch } from "@wfgraph/shared/conditions/condition-branch";
import {
  type ConditionModel,
  type ConditionRule,
  conditionRuleReadPath,
  isNullCheckConditionRule,
  isStringSetConditionRule,
  parseNodeOutputConditionPath,
} from "@wfgraph/shared/conditions/condition-model";
import { parseConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import {
  isLifecycleNode,
  isWaitNode,
  readConfigString,
} from "@wfgraph/shared/graph/node-config";
import { LIFECYCLE_CANCELED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import {
  resolveJsonPath,
  unwrapStepOutput,
} from "@wfgraph/shared/graph/node-references";
import type { ConditionBranch } from "@wfgraph/shared/graph/types";
import {
  isJsonObject,
  type JsonValue,
  readJsonValue,
} from "@wfgraph/shared/types/json";
import { isBlank } from "@wfgraph/shared/types/string";
import type { ExecutionLog } from "#src/lib/execution-logs";
import type { WorkflowEdge, WorkflowNode } from "#src/lib/workflow-graph-types";

/**
 * The value a rule read in the run: `value` when the record it reads holds one
 * at its path, `missing` when that record lacks the path, and `unrecorded`
 * when the run keeps no record of what the rule read, such as Entity State.
 */
export type ComparedValue =
  | { kind: "value"; value: JsonValue }
  | { kind: "missing" }
  | { kind: "unrecorded" };

export type ConditionRuleEvidence = {
  /**
   * Whether the rule matched, where the answer and the logic joining the
   * rules decide it, and null where they do not, such as one rule of an
   * all-rules group that answered False.
   */
  matched: boolean | null;
  /** The value the rule compared, or `unrecorded` where no record holds it. */
  compared: ComparedValue;
  /**
   * Whether this rule alone settled the answer: a rule that did not match in
   * an all-rules Condition that answered False, or one that matched in an
   * any-rule Condition that answered True. Read for a single group of rules.
   */
  decisive: boolean;
};

export type ConditionDecision = {
  branch: ConditionBranch;
  /** The steps the taken branch connects to, by node id, in edge order. */
  continuesTo: readonly string[];
  /** The rules the pinned graph stores, or null when none can be read. */
  model: ConditionModel | null;
  /** The evidence for each rule of `model`, by rule id. */
  rules: ReadonlyMap<string, ConditionRuleEvidence>;
};

/** The answer a Condition execution recorded, or null for none. */
function recordedAnswer(log: ExecutionLog): boolean | null {
  const value = unwrapStepOutput(readJsonValue(log.output));
  return isJsonObject(value) && typeof value.condition === "boolean"
    ? value.condition
    : null;
}

/**
 * Whether group `index` of `model` matched, given the Condition's `answer`.
 * One group is the answer. Groups joined by AND all matched when the answer is
 * True, and groups joined by OR all failed when it is False; any other case
 * leaves a single group unknown.
 */
function groupMatched(model: ConditionModel, answer: boolean): boolean | null {
  if (model.groups.length === 1) {
    return answer;
  }
  if (model.groupLogic === "and" && answer) {
    return true;
  }
  return model.groupLogic === "or" && !answer ? false : null;
}

/** Whether each rule of a group matched, by the same reading as the groups. */
function ruleMatched(
  group: ConditionModel["groups"][number],
  matched: boolean | null
): boolean | null {
  if (matched === null) {
    return null;
  }
  if (group.conditions.length === 1) {
    return matched;
  }
  if (group.logic === "and" && matched) {
    return true;
  }
  return group.logic === "or" && !matched ? false : null;
}

/** The latest successful execution of `nodeId` that started by `before`. */
function latestSuccess(
  logs: readonly ExecutionLog[],
  nodeId: string,
  before: Date
): ExecutionLog | undefined {
  return logs.findLast(
    (log) =>
      log.nodeId === nodeId &&
      log.status === "success" &&
      log.startedAt.getTime() <= before.getTime()
  );
}

/**
 * The payload of the Arriving Event on the Condition's branch, or null where
 * the records cannot say. The walk goes up the first incoming connection the
 * run took, as the engine hands an arrival down the first incoming edge. An
 * event-mode Wait hands on the Event that woke it, or none after a timeout;
 * the Started outlet hands on the Start Event's payload, which the Lifecycle
 * Node's own record holds. The Canceled outlet's payload is not recorded.
 */
function arrivingPayload(input: {
  nodeId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  logs: readonly ExecutionLog[];
  before: Date;
}): JsonValue | null {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let current = input.nodeId;
  while (!seen.has(current)) {
    seen.add(current);
    const edge = input.edges.find(
      (candidate) =>
        candidate.target === current &&
        (isLifecycleNode(byId.get(candidate.source)) ||
          latestSuccess(input.logs, candidate.source, input.before) !==
            undefined)
    );
    if (edge === undefined) return null;
    const source = byId.get(edge.source);
    if (isLifecycleNode(source)) {
      if (edge.sourceHandle === LIFECYCLE_CANCELED_HANDLE) return null;
      const start = latestSuccess(input.logs, edge.source, input.before);
      return start === undefined
        ? null
        : unwrapStepOutput(readJsonValue(start.output));
    }
    const record = latestSuccess(input.logs, edge.source, input.before);
    const output = unwrapStepOutput(readJsonValue(record?.output));
    if (
      isWaitNode(source) &&
      isJsonObject(output) &&
      output.waitType === "event"
    ) {
      // A Wait that timed out hands on no Event, so nothing is set.
      return output.payload ?? {};
    }
    current = edge.source;
  }
  return null;
}

/**
 * The value the rule reading `path` compared. A rule naming a step reads that
 * step's latest output recorded before `before`; one naming the Lifecycle Node
 * reads the branch's Arriving Event. A rule on Entity State or on the Event's
 * name reads what the records do not hold.
 */
function comparedValue(input: {
  path: string;
  conditionId: string;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  logs: readonly ExecutionLog[];
  before: Date;
}): ComparedValue {
  const reference = parseNodeOutputConditionPath(input.path);
  if (reference === null) {
    return { kind: "unrecorded" };
  }
  const referenced = input.nodes.find((node) => node.id === reference.nodeId);
  const record = isLifecycleNode(referenced)
    ? arrivingPayload({ ...input, nodeId: input.conditionId })
    : (() => {
        const source = latestSuccess(
          input.logs,
          reference.nodeId,
          input.before
        );
        return source === undefined
          ? null
          : unwrapStepOutput(readJsonValue(source.output));
      })();
  if (record === null) {
    return { kind: "unrecorded" };
  }
  const value = resolveJsonPath(record, reference.fieldPath);
  return value === undefined ? { kind: "missing" } : { kind: "value", value };
}

/**
 * Whether `rule` matched the value it compared, as the compiled expression
 * would answer, or null where that cannot be told from the value: a moment
 * relative to when the Condition ran, or a value of a type the rule does not
 * compare. An absent value fails every rule but "is not set".
 */
function ruleVerdict(
  rule: ConditionRule,
  compared: ComparedValue
): boolean | null {
  if (compared.kind === "unrecorded") return null;
  if (isNullCheckConditionRule(rule)) {
    return (compared.kind === "value") === (rule.operator === "is_set");
  }
  if (compared.kind === "missing") return false;
  const { value } = compared;
  switch (rule.fieldType) {
    case "number": {
      if (typeof value !== "number") return null;
      switch (rule.operator) {
        case "equals":
          return value === rule.value;
        case "not_equals":
          return value !== rule.value;
        case "greater_than":
          return value > rule.value;
        case "greater_or_equal":
          return value >= rule.value;
        case "less_than":
          return value < rule.value;
        default:
          return value <= rule.value;
      }
    }
    case "string": {
      if (typeof value !== "string") return null;
      if (isStringSetConditionRule(rule)) {
        const member = rule.values.includes(value);
        return rule.operator === "is_one_of" ? member : !member;
      }
      switch (rule.operator) {
        case "equals":
          return value === rule.value;
        case "not_equals":
          return value !== rule.value;
        default:
          return value.includes(rule.value);
      }
    }
    case "boolean":
      return typeof value === "boolean"
        ? value === (rule.operator === "is_true")
        : null;
    default:
      return null;
  }
}

/** Verdicts joined by `logic`, or null when one of them is unknown. */
function combine(
  logic: "and" | "or",
  values: readonly (boolean | null)[]
): boolean | null {
  if (values.includes(null)) return null;
  return logic === "and"
    ? values.every((value) => value === true)
    : values.some((value) => value === true);
}

/** The answer `model` gives for these rule verdicts, or null if one is unknown. */
function modelAnswer(
  model: ConditionModel,
  verdicts: ReadonlyMap<string, boolean | null>
): boolean | null {
  return combine(
    model.groupLogic,
    model.groups.map((group) =>
      combine(
        group.logic,
        group.conditions.map((rule) => verdicts.get(rule.id) ?? null)
      )
    )
  );
}

/**
 * What `execution`, a recorded execution of the Condition `nodeId`, decided,
 * or null when it recorded no answer. `config` is the Condition's
 * configuration and `edges` the connections of the graph the run pinned.
 * `logs` are the run's executions in start order.
 */
export function conditionDecision(input: {
  nodeId: string;
  execution: ExecutionLog;
  config: Readonly<Record<string, unknown>> | null;
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  logs: readonly ExecutionLog[];
}): ConditionDecision | null {
  const answer = recordedAnswer(input.execution);
  if (answer === null) {
    return null;
  }
  const branch: ConditionBranch = answer ? "true" : "false";
  const stored = readConfigString(input.config ?? undefined, "conditionModel");
  const parsed =
    stored === undefined || isBlank(stored)
      ? null
      : parseConditionModel(stored);
  const model = parsed?.valid ? parsed.model : null;
  const groupOutcome = model === null ? null : groupMatched(model, answer);
  const rules = (model?.groups ?? []).flatMap((group) => {
    const decided = ruleMatched(group, groupOutcome);
    return group.conditions.map((rule) => {
      const compared = comparedValue({
        path: conditionRuleReadPath(rule),
        conditionId: input.nodeId,
        nodes: input.nodes,
        edges: input.edges,
        logs: input.logs,
        before: input.execution.startedAt,
      });
      return {
        rule,
        decided,
        compared,
        evaluated: ruleVerdict(rule, compared),
      };
    });
  });
  // A verdict read from a value stands only while every one of them agrees
  // with what the answer decides and, where all are known, gives the answer
  // the Condition recorded. Otherwise the panel claims no verdict it cannot
  // stand behind.
  const evaluatedAgree =
    model !== null &&
    rules.every(
      (entry) =>
        entry.decided === null ||
        entry.evaluated === null ||
        entry.decided === entry.evaluated
    ) &&
    [
      modelAnswer(
        model,
        new Map(
          rules.map((entry) => [
            entry.rule.id,
            entry.decided ?? entry.evaluated,
          ])
        )
      ),
    ].every((derived) => derived === null || derived === answer);
  const onlyGroup = model?.groups.length === 1 ? model.groups[0] : undefined;
  const ruleEvidence = new Map(
    rules.map((entry) => {
      const matched =
        entry.decided ?? (evaluatedAgree ? entry.evaluated : null);
      const decisive =
        onlyGroup !== undefined &&
        onlyGroup.conditions.length > 1 &&
        matched !== null &&
        ((onlyGroup.logic === "and" && !answer && !matched) ||
          (onlyGroup.logic === "or" && answer && matched));
      return [
        entry.rule.id,
        { matched, compared: entry.compared, decisive },
      ] as const;
    })
  );
  return {
    branch,
    continuesTo: input.edges
      .filter(
        (edge) =>
          edge.source === input.nodeId &&
          normalizeConditionBranch(edge.sourceHandle) === branch
      )
      .map((edge) => edge.target),
    model,
    rules: ruleEvidence,
  };
}
