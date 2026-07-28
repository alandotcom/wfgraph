import { compact } from "es-toolkit/array";
import type { JsonValue } from "@/types/json";

/**
 * Reads a dot-separated path out of a value that arrived as JSON: a webhook
 * body, an Inngest event payload, a mock request pasted into the editor.
 *
 * The input is `JsonValue` because every caller is walking something that
 * crossed a wire. That is what lets the walk narrow with plain language checks
 * and hand back a `JsonValue`, so callers get a usable union rather than
 * `unknown`.
 */
export function getValueByPath(
  input: JsonValue | undefined,
  path: string | undefined
): JsonValue | undefined {
  if (!path) {
    return undefined;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return undefined;
  }

  const segments = compact(trimmed.split("."));
  let current: JsonValue | undefined = input;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    // Null and arrays are handled above, so an object here is a keyed JSON
    // object and the index read narrows on its own.
    if (typeof current === "object") {
      current = current[segment];
      continue;
    }

    return undefined;
  }

  return current;
}
