/**
 * How a Condition node's expression is decided: the flat namespace the run's
 * node outputs are folded into, and the CEL evaluation over it.
 */

import { evaluateCompiledCondition } from "#src/backend/lib/cel/condition-payload";
import {
  collectEntityStateConditionReferences,
  collectTimestampFieldPaths,
  parseConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import {
  parseOutputPath,
  unwrapStepOutput,
} from "@wfgraph/shared/graph/node-references";
import type { JsonObject, JsonValue } from "@wfgraph/shared/types/json";
import type { NodeOutputs } from "#src/backend/engine/contracts";
import { Effect } from "effect";

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
function readConditionContextShape(conditionModel: unknown): Effect.Effect<{
  timestampPaths: string[];
  entityPaths: string[];
}> {
  const parsed = parseConditionModel(conditionModel);
  if (!parsed.valid) {
    return Effect.as(
      Effect.logWarning("Condition model did not parse").pipe(
        Effect.annotateLogs({ error: parsed.error })
      ),
      { timestampPaths: [], entityPaths: [] }
    );
  }

  return Effect.succeed({
    timestampPaths: collectTimestampFieldPaths(parsed.model),
    entityPaths: collectEntityStateConditionReferences(parsed.model).map(
      (reference) => reference.fieldPath
    ),
  });
}

function setConditionContextValue(
  context: JsonObject,
  path: string,
  value: JsonValue
): void {
  const steps = parseOutputPath(path);
  if (!steps?.length) {
    return;
  }

  let current: JsonObject | JsonValue[] = context;
  for (const [index, step] of steps.entries()) {
    const key = step.kind === "key" ? step.key : step.index;
    if (index === steps.length - 1) {
      Reflect.set(current, key, structuredClone(value));
      return;
    }

    const nextStep = steps[index + 1];
    const existing: JsonValue | undefined =
      step.kind === "key" && !Array.isArray(current)
        ? current[step.key]
        : step.kind === "index" && Array.isArray(current)
          ? current[step.index]
          : undefined;
    if (nextStep?.kind === "index" && Array.isArray(existing)) {
      current = existing;
      continue;
    }
    if (
      nextStep?.kind === "key" &&
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      current = existing;
      continue;
    }

    const child: JsonObject | JsonValue[] =
      nextStep?.kind === "index" ? [] : {};
    Reflect.set(current, key, child);
    current = child;
  }
}

/** Build CEL's nested Entity root from the path-keyed durable projection. */
function entityConditionContext(
  values: JsonObject,
  paths: readonly string[]
): JsonObject {
  const context: JsonObject = {};
  for (const path of paths) {
    if (Object.hasOwn(values, path)) {
      setConditionContextValue(context, path, Reflect.get(values, path));
    }
  }
  return context;
}

export function evaluateConditionExpression(
  conditionExpression: unknown,
  outputs: NodeOutputs,
  conditionModel: unknown,
  /** The Event that put the run on the branch this node sits on. */
  eventName: string | null,
  /** Current tracked Entity State projected for this Condition node. */
  entity?: JsonObject
): Effect.Effect<ConditionEvalResult> {
  return Effect.gen(function* () {
    yield* Effect.logDebug("Evaluating condition expression").pipe(
      Effect.annotateLogs({ conditionExpression })
    );

    if (typeof conditionExpression === "boolean") {
      return { result: conditionExpression };
    }

    if (typeof conditionExpression !== "string") {
      yield* Effect.logWarning("Condition is neither boolean nor string").pipe(
        Effect.annotateLogs({ conditionExpression })
      );
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

    const conditionContext = yield* readConditionContextShape(conditionModel);
    const evaluation = evaluateCompiledCondition({
      expression,
      timestampPaths: conditionContext.timestampPaths,
      payload: merged,
      eventName,
      entity: entityConditionContext(
        entity ?? {},
        conditionContext.entityPaths
      ),
    });

    if (!evaluation.ok) {
      yield* Effect.logError("CEL condition evaluation failed").pipe(
        Effect.annotateLogs({
          error: evaluation.error,
          conditionExpression,
        })
      );
      return { result: false };
    }

    return { result: evaluation.value };
  });
}
