/**
 * The run counts a Workflows row marks, in the words every way into them
 * uses: the mark on the row, the row's actions menu and the page's palette.
 */

import { compact } from "es-toolkit/array";

/** The two run states a workflow row counts. */
export type RunMarkStatus = "failed" | "waiting";

/** One count on a row: "2 failed", whose runs are "runs". */
export type RunMark = {
  readonly status: RunMarkStatus;
  readonly count: number;
  readonly text: string;
  readonly runs: "run" | "runs";
};

/**
 * The marks a workflow's counts call for, failed first, and none for a count
 * of zero. `failedRecently` counts the failed runs among the ones the
 * workflow's Runs view lists, and `waiting` its runs waiting now.
 */
export function workflowRunMarks(counts: {
  readonly failedRecently: number;
  readonly waiting: number;
}): RunMark[] {
  return compact([
    counts.failedRecently > 0
      ? { status: "failed" as const, count: counts.failedRecently }
      : null,
    counts.waiting > 0
      ? { status: "waiting" as const, count: counts.waiting }
      : null,
  ]).map((mark) => ({
    ...mark,
    text: `${mark.count} ${mark.status}`,
    runs: mark.count === 1 ? "run" : "runs",
  }));
}
