/**
 * The line both run lists show about the host's run retention window, from the
 * `runRetentionMs` the list procedures answer. Null means the host keeps every
 * run, and then the lists say nothing.
 */

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function count(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/**
 * A retention window rounded to the largest unit that fits: whole days from one
 * day up, otherwise whole hours. The host's window is at least one hour, and
 * the count never reads below 1.
 */
export function retentionWindowLabel(ms: number): string {
  if (ms >= DAY_MS) return count(Math.round(ms / DAY_MS), "day");
  return count(Math.max(1, Math.round(ms / HOUR_MS)), "hour");
}

/** The sentence a run list shows for `runRetentionMs`, or null for none. */
export function runRetentionNotice(
  runRetentionMs: number | null
): string | null {
  return runRetentionMs === null
    ? null
    : `Runs are deleted ${retentionWindowLabel(runRetentionMs)} after they finish.`;
}
