/**
 * The line both run lists show about the host's run retention window, from the
 * `runRetentionMs` the list procedures answer. Null means the host keeps every
 * run, and then the lists say nothing.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function count(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/**
 * A retention window in the largest unit that divides it exactly: whole days,
 * then whole hours, then minutes rounded to the nearest one and never below 1.
 */
export function retentionWindowLabel(ms: number): string {
  if (ms >= DAY_MS && ms % DAY_MS === 0) return count(ms / DAY_MS, "day");
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) return count(ms / HOUR_MS, "hour");
  return count(Math.max(1, Math.round(ms / MINUTE_MS)), "minute");
}

/** The sentence a run list shows for `runRetentionMs`, or null for none. */
export function runRetentionNotice(
  runRetentionMs: number | null
): string | null {
  return runRetentionMs === null
    ? null
    : `Runs are deleted ${retentionWindowLabel(runRetentionMs)} after they finish.`;
}
