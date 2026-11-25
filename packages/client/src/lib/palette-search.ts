/**
 * How the command palette orders what a query matches.
 *
 * A row matches when the query appears anywhere in its label or its keywords,
 * ignoring case and accents, which is the match Base UI's own filter makes.
 * The rows are then ranked by where the query landed, so a row named by the
 * query comes before a row that merely mentions it. A query of digits alone
 * names a step by its number, so a numbered step matches it only when the
 * number is the query. Rows of equal rank keep
 * their authored order, and groups are ordered by their best row.
 */

import { sortBy } from "es-toolkit/array";

/** What the palette searches on a row. */
export type SearchableRow = {
  readonly label: string;
  /** Every word the row can be found by, its label included. */
  readonly keywords: string;
  /** The step's number in the outline, on a row that stands for a step. */
  readonly stepNumber?: number | undefined;
};

export type SearchableGroup<Row extends SearchableRow> = {
  readonly items: readonly Row[];
};

/** Lower case with accents removed, so "Résumé" matches "resume". */
export function normalizeSearchText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/**
 * The rank of `row` for `query`, lower first, or null when it does not match:
 * 0 when the label is the query or the query is the row's step number, 1 when the label starts with it, 2 when a word
 * of the label starts with it, 3 when the label holds it elsewhere, and 4 when
 * only the keywords hold it.
 */
export function paletteMatchRank(
  row: SearchableRow,
  query: string
): number | null {
  const needle = normalizeSearchText(query);
  const label = normalizeSearchText(row.label);
  if (needle === "") {
    return 0;
  }
  if (row.stepNumber !== undefined && /^\d+$/.test(needle)) {
    return Number(needle) === row.stepNumber ? 0 : null;
  }
  if (label === needle) {
    return 0;
  }
  if (label.startsWith(needle)) {
    return 1;
  }
  if (label.includes(` ${needle}`)) {
    return 2;
  }
  if (label.includes(needle)) {
    return 3;
  }
  return normalizeSearchText(row.keywords).includes(needle) ? 4 : null;
}

/**
 * The groups holding only the rows `query` matches, best rank first within
 * each group, and the groups ordered by their best row. A group left with no
 * rows is dropped.
 */
export function rankPaletteGroups<
  Row extends SearchableRow,
  Group extends SearchableGroup<Row>,
>(groups: readonly Group[], query: string): Group[] {
  const ranked = groups.flatMap((group, groupIndex) => {
    const rows = group.items.flatMap((row, rowIndex) => {
      const rank = paletteMatchRank(row, query);
      return rank === null ? [] : [{ row, rank, rowIndex }];
    });
    if (rows.length === 0) {
      return [];
    }
    const ordered = sortBy(rows, [
      (entry) => entry.rank,
      (entry) => entry.rowIndex,
    ]);
    return [
      {
        group: { ...group, items: ordered.map((entry) => entry.row) },
        best: ordered[0]?.rank ?? 0,
        groupIndex,
      },
    ];
  });
  return sortBy(ranked, [
    (entry) => entry.best,
    (entry) => entry.groupIndex,
  ]).map((entry) => entry.group);
}
