/**
 * Which outline rows show and where the keyboard goes among them. Pure, so the
 * component only holds the folded keys, the filter text and the focused key.
 * A folded key hides every row under it. A filter shows the rows whose words
 * hold the text, with the rows they sit under, and ignores folds.
 */

import type { OutlineRow } from "@wfgraph/shared/graph/workflow-outline";
import type { WorkflowEdge } from "@wfgraph/shared/graph/types";
import { LIFECYCLE_STARTED_HANDLE } from "@wfgraph/shared/lifecycle/lifecycle-outlets";
import type { StepOutlet } from "#src/lib/command-palette";

/** A line standing for rows a run's outline folds, such as "3 steps not reached yet". */
export type OutlineNoteRow = {
  kind: "note";
  key: string;
  /** The key of the first row the note stands for, which places it in its section. */
  standsFor: string;
  depth: number;
  parentKey: string | null;
  text: string;
};

/**
 * "Add a step" at an open end of a path, which the draft's outline adds: under
 * an outlet nothing is connected behind, after a step that leads nowhere, and
 * under "Steps" while nothing follows the start. `source` is the outlet the
 * new step joins.
 */
export type OutlineAddRow = {
  kind: "add";
  key: string;
  /** The key of the row it follows, which places it in its section. */
  standsFor: string;
  depth: number;
  parentKey: string | null;
  source: StepOutlet;
  text: string;
};

/**
 * A row the outline draws: one the model wrote, a note a run's outline adds,
 * or an "Add a step" row the draft's outline adds.
 */
export type OutlineDisplayRow = OutlineRow | OutlineNoteRow | OutlineAddRow;

/** The rows that carry a step or the Lifecycle Node, which select a card. */
export type OutlineNodeRow = Extract<
  OutlineRow,
  { kind: "lifecycle" | "step" | "group" }
>;

export function isNodeRow(row: OutlineDisplayRow): row is OutlineNodeRow {
  return (
    row.kind === "lifecycle" || row.kind === "step" || row.kind === "group"
  );
}

/**
 * Whether the keyboard stops on a row: a step, a Group, the Lifecycle Node, a
 * reference that leads to the step it names, or "Add a step". Outlet and arm
 * labels are read as headings and fold with the row they sit under.
 */
export function isFocusableRow(row: OutlineDisplayRow): boolean {
  return isNodeRow(row) || row.kind === "continues" || row.kind === "add";
}

const ADD_STEP_TEXT = "Add a step";

/**
 * `rows` with "Add a step" after every open end of a path in the draft:
 * beneath an outlet nothing is connected behind, after a step with no
 * connection out of it, and, while nothing follows the start's Started
 * outlet, first under "Steps". A Condition and an Event Split end in their
 * outlets, and a Group in its last member, so neither gets a row of its own.
 */
export function withAddStepRows(input: {
  rows: readonly OutlineRow[];
  edges: readonly WorkflowEdge[];
}): OutlineDisplayRow[] {
  const leaves = new Set(input.edges.map((edge) => edge.source));
  const lifecycle = input.rows.find((row) => row.kind === "lifecycle");
  const startOpen =
    lifecycle !== undefined &&
    !input.edges.some(
      (edge) =>
        edge.source === lifecycle.nodeId &&
        edge.sourceHandle === LIFECYCLE_STARTED_HANDLE
    );
  return input.rows.flatMap((row): OutlineDisplayRow[] => {
    if (row.kind === "lifecycle") {
      return startOpen
        ? [
            row,
            {
              kind: "add",
              key: `add:${row.nodeId}:${LIFECYCLE_STARTED_HANDLE}`,
              // Under no row of "Starts when", so it opens "Steps".
              standsFor: "",
              depth: 0,
              parentKey: null,
              source: { nodeId: row.nodeId, handle: LIFECYCLE_STARTED_HANDLE },
              text: ADD_STEP_TEXT,
            },
          ]
        : [row];
    }
    if (row.kind === "outlet" && row.ends) {
      return [
        row,
        {
          kind: "add",
          key: `add:${row.sourceNodeId}:${row.handle}`,
          standsFor: row.key,
          depth: row.depth + 1,
          parentKey: row.parentKey,
          source: { nodeId: row.sourceNodeId, handle: row.handle },
          text: ADD_STEP_TEXT,
        },
      ];
    }
    if (
      row.kind === "step" &&
      row.stepKind !== "condition" &&
      row.stepKind !== "event-split" &&
      !leaves.has(row.nodeId)
    ) {
      return [
        row,
        {
          kind: "add",
          key: `add:${row.nodeId}`,
          standsFor: row.key,
          depth: row.depth,
          parentKey: row.parentKey,
          source: { nodeId: row.nodeId, handle: null },
          text: ADD_STEP_TEXT,
        },
      ];
    }
    return [row];
  });
}

/** The words a filter is matched against. */
export function rowWords(row: OutlineDisplayRow): string {
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
  rows: readonly OutlineDisplayRow[],
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
export function foldableKeys(rows: readonly OutlineDisplayRow[]): Set<string> {
  return new Set(
    rows.flatMap((row) => (row.parentKey === null ? [] : [row.parentKey]))
  );
}

/** The rows shown for `folded` keys and a `filter` text. */
export function visibleRows(
  rows: readonly OutlineDisplayRow[],
  input: { folded: ReadonlySet<string>; filter: string }
): OutlineDisplayRow[] {
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
  shown: readonly OutlineDisplayRow[];
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
