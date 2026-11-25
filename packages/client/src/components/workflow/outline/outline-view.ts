/**
 * Which outline rows show and where the keyboard goes among them. Pure, so the
 * component only holds the folded keys, the filter text and the focused key.
 * A folded key hides every row under it. A filter shows the rows whose words
 * hold the text, with the rows they sit under, and ignores folds.
 */

import type { OutlineRow } from "@wfgraph/shared/graph/workflow-outline";

/** The rows that carry a step or the Lifecycle Node, which select a card. */
export type OutlineNodeRow = Extract<
  OutlineRow,
  { kind: "lifecycle" | "step" | "group" }
>;

export function isNodeRow(row: OutlineRow): row is OutlineNodeRow {
  return (
    row.kind === "lifecycle" || row.kind === "step" || row.kind === "group"
  );
}

/**
 * Whether the keyboard stops on a row: a step, a Group, the Lifecycle Node, or
 * a reference that leads to the step it names. Outlet and arm labels are read
 * as headings and fold with the row they sit under.
 */
export function isFocusableRow(row: OutlineRow): boolean {
  return isNodeRow(row) || row.kind === "continues";
}

/** The words a filter is matched against. */
export function rowWords(row: OutlineRow): string {
  switch (row.kind) {
    case "lifecycle":
    case "step":
    case "group":
      return `${row.label} ${row.summary ?? ""}`;
    default:
      return row.text;
  }
}

/** The keys of the rows `key` sits under, nearest first. */
export function ancestorKeys(
  rows: readonly OutlineRow[],
  key: string
): string[] {
  const parentOf = new Map(rows.map((row) => [row.key, row.parentKey]));
  const keys: string[] = [];
  let parent = parentOf.get(key) ?? null;
  while (parent !== null && !keys.includes(parent)) {
    keys.push(parent);
    parent = parentOf.get(parent) ?? null;
  }
  return keys;
}

/** The keys of the rows that have rows under them, which can fold. */
export function foldableKeys(rows: readonly OutlineRow[]): Set<string> {
  return new Set(
    rows.flatMap((row) => (row.parentKey === null ? [] : [row.parentKey]))
  );
}

/** The rows shown for `folded` keys and a `filter` text. */
export function visibleRows(
  rows: readonly OutlineRow[],
  input: { folded: ReadonlySet<string>; filter: string }
): OutlineRow[] {
  const query = input.filter.trim().toLowerCase();
  if (query !== "") {
    const shown = new Set<string>();
    for (const row of rows) {
      if (rowWords(row).toLowerCase().includes(query)) {
        shown.add(row.key);
        for (const key of ancestorKeys(rows, row.key)) shown.add(key);
      }
    }
    return rows.filter((row) => shown.has(row.key));
  }
  if (input.folded.size === 0) {
    return [...rows];
  }
  return rows.filter(
    (row) => !ancestorKeys(rows, row.key).some((key) => input.folded.has(key))
  );
}

/**
 * Where a key press moves focus among the `shown` rows, from the row `from`.
 * Up and Down step between focusable rows, Home and End jump to the ends, and
 * Left goes to the nearest focusable row `from` sits under. Null when the key
 * moves nothing.
 */
export function moveFocus(input: {
  shown: readonly OutlineRow[];
  from: string;
  key: "ArrowUp" | "ArrowDown" | "Home" | "End" | "parent" | "child";
}): string | null {
  const focusable = input.shown.filter(isFocusableRow);
  const index = focusable.findIndex((row) => row.key === input.from);
  switch (input.key) {
    case "ArrowUp":
      return index > 0 ? (focusable[index - 1]?.key ?? null) : null;
    case "ArrowDown":
      return index >= 0 && index < focusable.length - 1
        ? (focusable[index + 1]?.key ?? null)
        : null;
    case "Home":
      return focusable[0]?.key ?? null;
    case "End":
      return focusable.at(-1)?.key ?? null;
    case "parent": {
      const focusableKeys = new Set(focusable.map((row) => row.key));
      return (
        ancestorKeys(input.shown, input.from).find((key) =>
          focusableKeys.has(key)
        ) ?? null
      );
    }
    default: {
      // The first focusable row under `from`, through any label between them.
      const next = focusable[index + 1];
      return next && ancestorKeys(input.shown, next.key).includes(input.from)
        ? next.key
        : null;
    }
  }
}
