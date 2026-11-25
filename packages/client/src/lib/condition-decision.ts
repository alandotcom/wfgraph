/**
 * What one recorded execution of a Condition decided, in the terms a person
 * reads it in: the branch its answer took, the steps that branch connects to
 * in the graph the run pinned, and for each rule whether it matched and the
 * value it compared, where the run's evidence holds them. Pure.
 */

import { normalizeConditionBranch } from "@wfgraph/shared/conditions/condition-branch";
import {
  type ConditionModel,
  conditionRuleReadPath,
  parseNodeOutputConditionPath,
} from "@wfgraph/shared/conditions/condition-model";
import { parseConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { readConfigString } from "@wfgraph/shared/graph/node-config";
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
import type { WorkflowEdge } from "#src/lib/workflow-graph-types";

/**
 * The value a rule read in the run: `value` when the step it names recorded
 * one at its path, and `missing` when that step's output lacks the path.
 */
export type ComparedValue =
  | { kind: "value"; value: JsonValue }
  | { kind: "missing" };

export type ConditionRuleEvidence = {
  /**
   * Whether the rule matched, where the answer and the logic joining the
   * rules decide it, and null where they do not, such as one rule of an
   * all-rules group that answered False.
   */
  matched: boolean | null;
  /**
   * The value the rule compared, or null where the run's evidence holds no
   * record of it: a rule on Entity State, or on a step with no recorded output
   * before this execution.
   */
  compared: ComparedValue | null;
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

/**
 * The value the rule reading `path` compared, from the latest output the step
 * it names recorded before `before`. A rule naming no step reads Entity State
 * or the run's merged payload, which the evidence does not hold.
 */
function comparedValue(input: {
  path: string;
  logs: readonly ExecutionLog[];
  before: Date;
}): ComparedValue | null {
  const reference = parseNodeOutputConditionPath(input.path);
  if (reference === null) {
    return null;
  }
  const source = input.logs.findLast(
    (log) =>
      log.nodeId === reference.nodeId &&
      log.status === "success" &&
      log.startedAt.getTime() <= input.before.getTime()
  );
  if (source === undefined) {
    return null;
  }
  const value = resolveJsonPath(
    unwrapStepOutput(readJsonValue(source.output)),
    reference.fieldPath
  );
  return value === undefined ? { kind: "missing" } : { kind: "value", value };
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
  const rules = new Map(
    (model?.groups ?? []).flatMap((group) => {
      const matched = ruleMatched(group, groupOutcome);
      return group.conditions.map(
        (rule) =>
          [
            rule.id,
            {
              matched,
              compared: comparedValue({
                path: conditionRuleReadPath(rule),
                logs: input.logs,
                before: input.execution.startedAt,
              }),
            },
          ] as const
      );
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
    rules,
  };
}
