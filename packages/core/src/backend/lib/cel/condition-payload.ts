/**
 * Evaluating a compiled condition against one payload.
 *
 * Two callers reach the same question from different directions. A Condition node
 * asks it of the merged outputs of the nodes above it; a Wait Subscription asks it
 * of the Event payload that just arrived. Both hold a CEL string compiled from a
 * `ConditionModel` and a list of the paths that model treats as timestamps, and
 * both need the same preparation before CEL sees the value.
 */

import { evaluateCelBooleanExpression } from "#src/backend/lib/cel/environment";
import type { JsonObject } from "@rova/shared/types/json";
import { decodeIsoTimestamp } from "@rova/shared/types/timestamp";
import {
  CONDITION_CONTEXT_ROOT,
  EVENT_CONTEXT_ROOT,
} from "@rova/shared/conditions/conditions";

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
): { parent: object; key: string; value: unknown } | null {
  const segments = path.split(".");
  const key = segments.pop();
  if (!key) {
    return null;
  }

  let parent: object = context;
  for (const segment of segments) {
    const next: unknown = Reflect.get(parent, segment);
    // Only a keyed object can hold the rest of the path. An array stops the
    // walk: a condition field names a property, never an index.
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return null;
    }
    parent = next;
  }

  return { parent, key, value: Reflect.get(parent, key) };
}

/**
 * Turn the fields a condition treats as timestamps into `Date`s.
 *
 * A payload carries a timestamp as an ISO string, and CEL refuses to compare a
 * string against a Timestamp: without this step `appointment.startsAt > now`
 * fails to evaluate and the expression silently reads false. The model names the
 * paths it treats as timestamps, so those paths, and nothing else, are converted.
 * Values the templating path reads are untouched, because that path renders text
 * and wants the string exactly as the payload sent it.
 *
 * A path that is missing, already a `Date`, or holding text that is not a
 * timestamp is left as found, and the expression then fails the way it would
 * have anyway, naming the field in its error.
 *
 * The context handed here has to be private to this evaluation, since the write
 * lands inside whatever object holds the path.
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
      [EVENT_CONTEXT_ROOT]: { name: input.eventName },
      [CONDITION_CONTEXT_ROOT]: payload,
    },
  });
}
