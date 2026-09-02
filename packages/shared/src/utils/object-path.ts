import { compact } from "es-toolkit/array";
import { isJsonObject, type JsonObject, type JsonValue } from "#src/types/json";
import { isSafeRecordPath } from "#src/types/record-key";

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
  if (!trimmed || !isSafeRecordPath(trimmed)) {
    return undefined;
  }

  const segments = compact(trimmed.split("."));
  let current: JsonValue | undefined = input;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }

    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return undefined;
      }
      const index = Number(segment);
      if (!Number.isSafeInteger(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }

    // Null and arrays are handled above, so an object here is a keyed JSON
    // object and the index read narrows on its own.
    if (isJsonObject(current)) {
      current = Object.hasOwn(current, segment) ? current[segment] : undefined;
      continue;
    }

    return undefined;
  }

  return current;
}

/**
 * Writes a dot-separated path into a JSON object, building the objects the path
 * walks through. The test-payload form is the caller: it holds one flat value per
 * declared field path and this is what assembles them into the nested payload an
 * Event declares.
 *
 * Every segment addresses an object key, so a numeric segment builds a key rather
 * than an array index. Whatever sat at a segment that is not an object is
 * replaced, because a path the caller asked for wins over a value that cannot
 * hold it.
 *
 * A path naming a reserved key writes nothing and answers `false`, so a caller
 * assembling several fields can tell a refused write from a stored one. The form
 * that calls this already drops such a path in `isFormAddressable`, which is
 * where the operator sees the field is unavailable; this is the backstop under
 * it.
 */
export function setValueByPath(
  target: JsonObject,
  path: string,
  value: JsonValue
): boolean {
  if (!isSafeRecordPath(path)) {
    return false;
  }

  const segments = compact(path.trim().split("."));
  const leaf = segments.pop();
  if (!leaf) {
    return false;
  }

  let current = target;
  for (const segment of segments) {
    const existing = Object.hasOwn(current, segment)
      ? current[segment]
      : undefined;
    const next = isJsonObject(existing) ? existing : {};
    current[segment] = next;
    current = next;
  }

  current[leaf] = value;
  return true;
}
