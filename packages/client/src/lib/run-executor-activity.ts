/**
 * The sentences the Runs view uses to say what the database executor is doing
 * about an in-progress run. The server decides which case holds
 * (`schedule.activity` on a run's logs, `activity` on a runs list row); this
 * module only words it.
 *
 * Elapsed times ("for 3 min", "22 s ago") are measured on the server's clock:
 * the server's `observedAt` plus the time since the browser received the
 * answer, so a browser whose clock is off does not misreport a wait.
 */

import { formatClockTime } from "@wfgraph/shared/utils/time";
import { compact } from "es-toolkit/array";
import type { ExecutionLogsResult } from "#src/lib/rpc-client";

/** Where the executor holds an in-progress run, as `getExecutionLogs` answers it. */
export type ExecutorSchedule = NonNullable<ExecutionLogsResult["schedule"]>;

/** The server's decision about a run, as the run overview reads it. */
export type ScheduleActivity = NonNullable<ExecutorSchedule["activity"]>;

/**
 * How long a run may sit due without a worker claiming it before the Runs view
 * says so as a problem. A worker loop polls far more often than this, so a run
 * still unclaimed after a minute means no worker is reaching this database.
 */
export const UNCLAIMED_WARNING_MS = 60_000;

/** The server's clock, as the browser estimates it from the last answer. */
export function serverNowMs(input: {
  /** The server's clock when it answered, as an ISO string. */
  observedAt: string;
  /** The browser's clock when the answer arrived. */
  receivedAtMs: number;
  /** The browser's clock now. */
  nowMs: number;
}): number {
  return (
    Date.parse(input.observedAt) + Math.max(0, input.nowMs - input.receivedAtMs)
  );
}

/** A local wall clock reading with seconds, as `14:32:05`. */
export function clockTimeWithSeconds(instant: string): string {
  const date = new Date(instant);
  return `${formatClockTime(date)}:${date.getSeconds().toString().padStart(2, "0")}`;
}

/**
 * A length of time in the largest units that keep it short: `45 s`, `3 min`,
 * `2 h 5 min`, `3 d 4 h`. Rounded down, and never below `0 s`.
 */
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/** How long ago `instant` was on the server's clock, in milliseconds. */
function elapsedMs(instant: string, nowMs: number): number {
  return nowMs - Date.parse(instant);
}

/** A node's name as the copy quotes it. */
function quoted(name: string): string {
  return `“${name}”`;
}

/**
 * Names a node the executor reported: the name its log row records, and
 * otherwise whatever the caller can find for the id, such as the pinned
 * graph's label. Answers null only for no node at all.
 */
export type NodeNamer = (node: {
  nodeId: string | null;
  nodeName: string | null;
}) => string | null;

/** What the run overview says about the executor, ready to render. */
export type ExecutorActivityCopy = {
  headline: string;
  /** A second line under the headline, or null for none. */
  detail: string | null;
  /** `warning` draws the section in the warning token. */
  tone: "default" | "warning";
};

const NO_WORKER_HELP =
  "Runs are claimed by the worker loop of createWfGraphApp or createWfGraphRunner, or by the Worker's Cron Trigger. Check that one of them is running against this database.";

const LEASE_EXPIRED_HELP =
  "The next worker to claim the run will count a failure against the step and try it again.";

/** The headline of a run whose park a producer resolved. */
function resumingHeadline(
  activity: Extract<ScheduleActivity, { kind: "resuming" }>
): string {
  switch (activity.wake) {
    case "resume": {
      const at =
        activity.wokenAt === null
          ? ""
          : ` at ${clockTimeWithSeconds(activity.wokenAt)}`;
      return activity.eventName === null
        ? `Resuming: resumed${at}`
        : `Resuming: ${activity.eventName} arrived${at}`;
    }
    case "timeout":
      return activity.deadline === null
        ? "Resuming: the wait's deadline passed"
        : `Resuming: the wait's deadline passed at ${clockTimeWithSeconds(activity.deadline)}`;
    case "cancel":
      return "Canceling: a Cancel Event claimed this run";
    case "exit":
      return "Exiting: Entity eligibility no longer passes";
    default:
      return "Moving to the new version";
  }
}

/**
 * The run overview's sentences for `activity` at `nowMs` on the server's
 * clock, or null for a run asleep on its parks, which the overview's waits
 * already explain.
 */
export function executorActivityCopy(input: {
  activity: ScheduleActivity;
  nameOf: NodeNamer;
  nowMs: number;
}): ExecutorActivityCopy | null {
  const { activity, nameOf, nowMs } = input;
  switch (activity.kind) {
    case "running": {
      const node = nameOf(activity);
      const on = activity.workerId === null ? "" : ` on ${activity.workerId}`;
      return {
        headline:
          node === null
            ? `Running${on}, between steps`
            : `Running ${quoted(node)}${on}`,
        detail: null,
        tone: "default",
      };
    }
    case "lease_expired": {
      const node = nameOf(activity);
      return {
        headline: `The worker running ${node === null ? "the run" : quoted(node)} stopped renewing its lease at ${clockTimeWithSeconds(activity.since)}.`,
        detail: LEASE_EXPIRED_HELP,
        tone: "default",
      };
    }
    case "retrying": {
      const node = nameOf(activity);
      const what = node === null ? "the run" : quoted(node);
      return {
        headline: `Retrying ${what} at ${clockTimeWithSeconds(activity.nextTryAt)}, try ${activity.failures + 1} of ${activity.retryLimit + 1}`,
        detail: activity.error,
        tone: "default",
      };
    }
    case "unclaimed": {
      const since = clockTimeWithSeconds(activity.dueSince);
      const waited = elapsedMs(activity.dueSince, nowMs);
      return waited < UNCLAIMED_WARNING_MS
        ? {
            headline: `Queued for a worker since ${since}`,
            detail: null,
            tone: "default",
          }
        : {
            headline: `Queued since ${since}. No worker has claimed this run for ${shortDuration(waited)}.`,
            detail: NO_WORKER_HELP,
            tone: "warning",
          };
    }
    case "resuming": {
      const waitingForWorker =
        activity.unclaimedSince !== null &&
        elapsedMs(activity.unclaimedSince, nowMs) >= UNCLAIMED_WARNING_MS;
      return {
        headline: `${resumingHeadline(activity)}${waitingForWorker ? ", waiting for a worker" : ""}`,
        detail: null,
        tone: "default",
      };
    }
    default:
      return null;
  }
}

/** One fact in the overview's "Executor details" list. */
export type ExecutorDetail = {
  term: string;
  value: string;
  /** Whether the value is an identifier, set in the monospace face. */
  mono: boolean;
};

const SCHEDULE_STATE_WORDS: Record<ExecutorSchedule["state"], string> = {
  queued: "Queued",
  leased: "Leased",
  waiting: "Waiting",
};

/** `in 22 s` for an instant ahead of `nowMs`, and `22 s ago` for one behind. */
function relativeToNow(instant: string, nowMs: number): string {
  const ms = Date.parse(instant) - nowMs;
  return ms > 0 ? `in ${shortDuration(ms)}` : `${shortDuration(-ms)} ago`;
}

/**
 * The facts under the overview's "Executor details" disclosure, leaving out
 * any the schedule does not hold.
 */
export function executorDetails(input: {
  schedule: ExecutorSchedule;
  nowMs: number;
}): ExecutorDetail[] {
  const { schedule, nowMs } = input;
  return compact([
    {
      term: "Schedule",
      value:
        schedule.state === "queued"
          ? `${SCHEDULE_STATE_WORDS.queued}, due ${clockTimeWithSeconds(schedule.wakeAt)}`
          : SCHEDULE_STATE_WORDS[schedule.state],
      mono: false,
    },
    {
      term: "Run failures",
      value: `${schedule.attempt} of ${schedule.retryLimit}`,
      mono: false,
    },
    schedule.leaseExpiresAt === null
      ? null
      : {
          term: "Lease expires",
          value: `${clockTimeWithSeconds(schedule.leaseExpiresAt)} (${relativeToNow(schedule.leaseExpiresAt, nowMs)})`,
          mono: false,
        },
    schedule.workerId === null
      ? null
      : { term: "Worker", value: schedule.workerId, mono: false },
    schedule.runningStepId === null
      ? null
      : { term: "Running step", value: schedule.runningStepId, mono: true },
  ]);
}
