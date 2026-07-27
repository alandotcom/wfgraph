import { compact } from "es-toolkit/array";
import { parseCsvSet as parseCsvSetFromCsv } from "./csv";

export function parseCsvSet(value: unknown): Set<string> {
  return parseCsvSetFromCsv(value);
}

export function getValueByPath(
  input: unknown,
  path: string | undefined
): unknown {
  if (!path) {
    return;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return;
  }

  const segments = compact(trimmed.split("."));
  let current: unknown = input;

  for (const segment of segments) {
    if (current === null || current === undefined) {
      return;
    }

    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (Number.isNaN(index)) {
        return;
      }
      current = current[index];
      continue;
    }

    // Null, undefined and arrays are handled above, so an object here is a
    // keyed value. Reflect.get is the same read as `current[segment]`, including
    // inherited keys, and hands back `unknown` without a cast.
    if (typeof current === "object") {
      current = Reflect.get(current, segment);
      continue;
    }

    return;
  }

  return current;
}
