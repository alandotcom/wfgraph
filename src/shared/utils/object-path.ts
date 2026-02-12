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

    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }

    return;
  }

  return current;
}
