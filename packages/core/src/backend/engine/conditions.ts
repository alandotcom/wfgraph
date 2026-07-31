/**
 * How a Condition node's expression is decided: the flat namespace the run's
 * node outputs are folded into, and the CEL evaluation over it.
 */

import { evaluateCompiledCondition } from "#src/backend/lib/cel/condition-payload";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  collectTimestampFieldPaths,
  parseConditionModel,
} from "@rova/shared/conditions/conditions";
import { unwrapStepOutput } from "@rova/shared/graph/node-references";
import type { JsonObject, JsonValue } from "@rova/shared/types/json";
import type { NodeOutputs } from "#src/backend/engine/contracts";

export const conditionLogger = getAppLogger("workflow", "executor").getChild(
  "condition"
);

type ConditionEvalResult = {
  result: boolean;
};

/**
 * Fold one node's output into the flat namespace a CEL condition reads from.
 *
 * Steps return their fields inside a `{ success, data }` wrapper, and a condition
 * names those fields by path alone (`payload.donorId == "abc"`), so the output goes
 * through the same unwrapping a template token gets before its keys are lifted into
 * the namespace.
 *
 * Known hazard, deliberately left alone: the namespace is flat across every node,
 * so two nodes that both produce a field called `id` collide, and the node that
 * runs later wins. Node-qualifying it would mean naming a node in every rule.
 */
function mergeConditionContextValue(context: JsonObject, value: JsonValue) {
  const record = unwrapStepOutput(value);
  // A node output is JSON that came back from a plugin's own API call, so its
  // shape belongs to that API and nothing here knows it. Only a keyed object
  // contributes names: copying a string or an array would spread index keys
  // into the namespace and let a condition read `0`.
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return;
  }

  Object.assign(context, record);

  const nestedInput = Reflect.get(record, "input");
  if (
    typeof nestedInput !== "object" ||
    nestedInput === null ||
    Array.isArray(nestedInput)
  ) {
    return;
  }

  for (const key of Object.keys(nestedInput)) {
    if (!(key in context)) {
      context[key] = Reflect.get(nestedInput, key);
    }
  }
}

/**
 * The timestamp field paths a Condition node's stored model declares.
 *
 * Saving a workflow rejects a Condition node whose model is missing or does not
 * compile to the expression beside it, so a model that fails to parse here
 * belongs to a node that never should have run; the condition still evaluates,
 * against a context where timestamps stay strings.
 */
function readConditionTimestampPaths(conditionModel: unknown): string[] {
  const parsed = parseConditionModel(conditionModel);
  if (!parsed.valid) {
    conditionLogger.warn("Condition model did not parse", {
      error: parsed.error,
    });
    return [];
  }

  return collectTimestampFieldPaths(parsed.model);
}

export function evaluateConditionExpression(
  conditionExpression: unknown,
  outputs: NodeOutputs,
  conditionModel: unknown
): ConditionEvalResult {
  conditionLogger.debug("Evaluating condition expression", {
    conditionExpression,
  });

  if (typeof conditionExpression === "boolean") {
    return { result: conditionExpression };
  }

  if (typeof conditionExpression !== "string") {
    conditionLogger.warn("Condition is neither boolean nor string", {
      conditionExpression,
    });
    return { result: false };
  }

  const expression = conditionExpression.trim();
  if (!expression) {
    return { result: false };
  }

  const merged: JsonObject = {};
  for (const output of Object.values(outputs)) {
    mergeConditionContextValue(merged, output.data);
  }

  const evaluation = evaluateCompiledCondition({
    expression,
    timestampPaths: readConditionTimestampPaths(conditionModel),
    payload: merged,
  });

  if (!evaluation.ok) {
    conditionLogger.error("CEL condition evaluation failed", {
      error: evaluation.error,
      conditionExpression,
    });
    return { result: false };
  }

  return { result: evaluation.value };
}
