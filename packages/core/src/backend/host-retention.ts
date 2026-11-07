/**
 * The host's two retention windows, `events.retentionMs` and `runs.retentionMs`,
 * checked and defaulted once by each entry point before anything opens.
 * `resolveRetention` throws a plain `Error` naming the option and its rule,
 * and never quotes the value it refused.
 */

import type { WfGraphEventsOptions } from "#src/backend/host-events";
import type { WfGraphRunsOptions } from "#src/backend/host-runs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a settled inbox row is kept after it arrived when the host sets no
 * `events.retentionMs`: seven days, so a host retrying a send over a weekend
 * still finds its first row.
 */
const DEFAULT_INBOX_RETENTION_MS = 7 * DAY_MS;

/** The shortest `runs.retentionMs`; `WfGraphRunsOptions` says why. */
const MIN_RUN_RETENTION_MS = HOUR_MS;

/**
 * The longest window either option takes: 100 years. A sweep's cutoff is its
 * start time minus the window, and a far larger window puts that cutoff
 * outside the range a `Date` holds, so every sweep would throw.
 */
const MAX_RETENTION_MS = 36_525 * DAY_MS;

/** The windows a worker loop or a tick sweeps with, in milliseconds. */
export type RetentionWindows = {
  /** How long a delivered or failed inbox row is kept after it arrived. */
  readonly inboxMs: number;
  /**
   * How long an ended run is kept after it completed, or undefined when the
   * host keeps every run.
   */
  readonly runMs: number | undefined;
};

/** Whether `value` is a whole number of milliseconds from `min` to `MAX_RETENTION_MS`. */
function isWindow(value: number, min: number): boolean {
  return Number.isInteger(value) && value >= min && value <= MAX_RETENTION_MS;
}

/**
 * Checks the host's `events` and `runs` windows and fills in the inbox
 * default. `caller` names the function the host called, which the message
 * of a refused window starts with.
 */
export function resolveRetention(input: {
  events: Pick<WfGraphEventsOptions, "retentionMs"> | undefined;
  runs: WfGraphRunsOptions | undefined;
  caller: string;
}): RetentionWindows {
  const { caller } = input;
  const inboxMs = input.events?.retentionMs ?? DEFAULT_INBOX_RETENTION_MS;
  if (!isWindow(inboxMs, 1)) {
    throw new Error(
      `${caller}'s events.retentionMs must be a positive integer of milliseconds, at most 100 years. Leave it out to keep settled inbox rows for seven days.`
    );
  }
  const runMs = input.runs?.retentionMs;
  if (runMs !== undefined && !isWindow(runMs, MIN_RUN_RETENTION_MS)) {
    throw new Error(
      `${caller}'s runs.retentionMs must be an integer of milliseconds from one hour to 100 years. Leave it out to keep every run.`
    );
  }
  return { inboxMs, runMs };
}
