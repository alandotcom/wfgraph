import { compact, uniq } from "es-toolkit/array";

export function parseCsvEntries(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return uniq(compact(value.split(",").map((entry) => entry.trim())));
}

export function parseCsvSet(value: unknown): Set<string> {
  return new Set(parseCsvEntries(value));
}
