/**
 * An Event's `source.when` filter, read in process: one payload path compared
 * against one string. The executor's delivery body evaluates it to tell which
 * Event on a shared source an arrival is, with the same answer the compiled
 * CEL expression in `inngest-event-data.ts` gives.
 */

import { compact } from "es-toolkit/array";
import { isJsonObject, type JsonObject } from "#src/types/json";

/** A source filter: the payload path to read and the string it must equal. */
export type EventSourceFilter = {
  readonly path: string;
  readonly equals: string;
};

/**
 * A source filter's path as segments, split on dots and trimmed. A path that
 * names no field throws.
 */
export function sourceFilterSegments(path: string): string[] {
  const segments = compact(path.split(".").map((segment) => segment.trim()));

  if (segments.length === 0) {
    throw new Error("A source filter needs a payload path to compare");
  }

  return segments;
}

/**
 * Whether `data` satisfies `when`: the value at the filter's path is a string
 * equal to `equals`. Each segment reads an own key of a JSON object, so a path
 * through an array, a missing key or a value of another type answers false,
 * where the CEL expression errors and Inngest skips the trigger.
 */
export function matchesSourceFilter(
  when: EventSourceFilter,
  data: JsonObject
): boolean {
  let value: JsonObject[string] | undefined = data;
  for (const segment of sourceFilterSegments(when.path)) {
    if (!isJsonObject(value) || !Object.hasOwn(value, segment)) return false;
    value = value[segment];
  }
  return value === when.equals;
}
