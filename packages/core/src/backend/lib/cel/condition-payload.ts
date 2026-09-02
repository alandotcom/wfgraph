/**
 * Evaluating a compiled condition against one payload.
 *
 * Three callers reach the same question from different directions. A Condition
 * node asks it of the merged outputs of the nodes above it; a Wait Subscription
 * asks it of the Event payload that just arrived; a Start Filter asks it of an
 * arriving payload before any run exists. All three need the same preparation
 * before CEL sees the value: a CEL string compiled from a `ConditionModel`, and
 * the list of paths that model treats as timestamps.
 */

import {
  type CelEvaluationResult,
  evaluateCelBooleanExpression,
} from "#src/backend/lib/cel/environment";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { decodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import {
  collectTimestampFieldPaths,
  compileConditionModel,
  CONDITION_CONTEXT_ROOT,
  EVENT_CONTEXT_ROOT,
  parseConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { parseOutputPath } from "@wfgraph/shared/graph/node-references";

/**
 * Read a dotted field path out of the condition context.
 *
 * Paths come from the condition model, where the user picked them off a schema,
 * so a path that finds nothing here means the payload did not carry that field
 * on this run.
 */
function readContextPath(
  context: JsonObject,
  path: string
): { parent: object; key: string | number; value: unknown } | null {
  const steps = parseOutputPath(path);
  if (!steps) {
    return null;
  }

  let current: unknown = context;
  for (const [index, step] of steps.entries()) {
    const isLast = index === steps.length - 1;
    if (step.kind === "key") {
      if (
        typeof current !== "object" ||
        current === null ||
        Array.isArray(current)
      ) {
        return null;
      }
      if (isLast) {
        return {
          parent: current,
          key: step.key,
          value: Reflect.get(current, step.key),
        };
      }
      current = Reflect.get(current, step.key);
      continue;
    }

    if (!Array.isArray(current)) {
      return null;
    }
    if (isLast) {
      return {
        parent: current,
        key: step.index,
        value: current[step.index],
      };
    }
    current = current[step.index];
  }

  return null;
}

/**
 * Turn the fields a condition treats as timestamps into `Date`s.
 *
 * A payload carries a timestamp as an ISO string, and CEL refuses to compare a
 * string against a Timestamp: without this step `appointment.startsAt > now`
 * fails to evaluate and the expression silently reads false. The model names
 * the paths it treats as timestamps, so those paths, and nothing else, are
 * converted. Values the templating path reads are untouched, because that path
 * renders text and wants the string exactly as the payload sent it.
 *
 * A path that is missing, already a `Date`, or holding text that is not a
 * timestamp is left as found, and the expression then fails the way it would
 * have anyway, naming the field in its error.
 *
 * The context handed here has to be private to this evaluation, because the
 * write lands inside whatever object holds the path.
 */
function decodeConditionTimestamps(
  context: JsonObject,
  paths: readonly string[]
) {
  for (const path of paths) {
    const located = readContextPath(context, path);
    if (!located || typeof located.value !== "string") {
      continue;
    }

    const decoded = decodeIsoTimestamp(located.value);
    if (decoded) {
      Reflect.set(located.parent, located.key, decoded);
    }
  }
}

/**
 * Whether one compiled condition holds for one payload.
 *
 * The payload is cloned before the timestamp decode, because that decode writes
 * `Date`s into whatever object holds each path: sharing the write would hand a
 * downstream template a `Date` where the payload has an ISO string, which renders
 * as a quoted UTC instant no timestamp parser accepts. Everything reaching here
 * is JSON, so one clone is enough.
 */
export function evaluateCompiledCondition(input: {
  expression: string;
  /** Field paths the model compiled these against as timestamps. */
  timestampPaths: readonly string[];
  payload: JsonObject;
  /**
   * The Event this payload arrived on, null where nothing named one. The key is
   * written either way, because an absent CEL root raises where a null value
   * compares false.
   */
  eventName: string | null;
}) {
  const payload = structuredClone(input.payload);
  decodeConditionTimestamps(payload, input.timestampPaths);

  return evaluateCelBooleanExpression({
    expression: input.expression,
    context: {
      now: new Date(),
      [EVENT_CONTEXT_ROOT]: {
        name: input.eventName,
      },
      [CONDITION_CONTEXT_ROOT]: payload,
    },
  });
}

/**
 * Whether one stored condition model holds for one payload.
 *
 * The third caller of the evaluator above, and the only one compiling as it goes.
 * A Condition node keeps the CEL it compiled to and a Wait Subscription compiles
 * at park time, because each has run-side values to fold in first. A Start Filter
 * has none: it is read before any run exists, so the stored model is complete on
 * its own and compiling it costs one pass of string building per arrival.
 */
export function evaluateSerializedCondition(input: {
  /** Serialized `ConditionModel`, as the Lifecycle Rules store it. */
  model: string;
  payload: JsonObject;
  eventName: string;
}): CelEvaluationResult {
  const parsed = parseConditionModel(input.model);
  if (!parsed.valid) {
    return { ok: false, error: parsed.error };
  }

  const compiled = compileConditionModel(parsed.model);
  if (!compiled.valid) {
    return { ok: false, error: compiled.error };
  }

  return evaluateCompiledCondition({
    expression: compiled.expression,
    timestampPaths: collectTimestampFieldPaths(parsed.model),
    payload: input.payload,
    eventName: input.eventName,
  });
}
