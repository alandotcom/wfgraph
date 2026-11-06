/**
 * The sentences the Runs view uses to say what the database executor is doing
 * about an in-progress run, and how a node's retries read. The server decides
 * which case holds (`schedule.activity` on a run's logs, `activity` on a runs
 * list row); this module only words it.
 *
 * Elapsed times ("for 3 min", "22 s ago") are measured on the server's clock:
 * the server's `observedAt` plus the time since the browser received the
 * answer, so a browser whose clock is off does not misreport a wait.
 */

import { formatClockTimeWithSeconds } from "@wfgraph/shared/utils/time";
import { compact } from "es-toolkit/array";
import type {
  ExecutionLogsResult,
  WorkflowExecutionsGlobalResult,
} from "#src/lib/rpc-client";

/** Where the executor holds an in-progress run, as `getExecutionLogs` answers it. */
export type ExecutorSchedule = NonNullable<ExecutionLogsResult["schedule"]>;

/** The server's decision about a run, as the run overview reads it. */
export type ScheduleActivity = NonNullable<ExecutorSchedule["activity"]>;

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

/** An instant the server reported, as a local clock reading with seconds. */
function clockTimeWithSeconds(instant: string): string {
  return formatClockTimeWithSeconds(new Date(instant));
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
  /** The schedule's `overdueAfterMs`: how long a due run waits before it is a problem. */
  overdueAfterMs: number;
}): ExecutorActivityCopy | null {
  const { activity, nameOf, nowMs, overdueAfterMs } = input;
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
      return waited < overdueAfterMs
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
        elapsedMs(activity.unclaimedSince, nowMs) >= overdueAfterMs;
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

/**
 * The server's clock and threshold a runs list page was answered with: its
 * `observedAt` and `overdueAfterMs`.
 */
export type ExecutorReading = { observedAt: string; overdueAfterMs: number };

/**
 * The server's decision about a run, as both runs lists carry it on a row
 * (`retrying`, `lease_expired` or `unclaimed`), with the reading of the page
 * the row arrived on, so a row from an older page keeps its own clock.
 */
export type ListActivity = NonNullable<
  WorkflowExecutionsGlobalResult["items"][number]["activity"]
> &
  ExecutorReading;

/** A row's `activity` with its page's reading, or null for none. */
export function withExecutorReading(
  activity: WorkflowExecutionsGlobalResult["items"][number]["activity"],
  reading: ExecutorReading
): ListActivity | null {
  return activity === null
    ? null
    : {
        ...activity,
        observedAt: reading.observedAt,
        overdueAfterMs: reading.overdueAfterMs,
      };
}

/** What a runs list row says in place of its status word, ready to render. */
export type ListActivityLabel = {
  text: string;
  /** Whether the text is drawn in the warning token. */
  warns: boolean;
};

/**
 * What a runs list row says about `activity` in place of its usual outcome,
 * or null to keep that outcome. An unclaimed run is said only once it has
 * waited the activity's `overdueAfterMs`, measured on the server's clock from
 * the activity's own `observedAt`, `receivedAtMs` and `nowMs`; with no
 * `receivedAtMs`, as for rows the list shows while it loads, it is not said.
 * A node without a recorded name is named by its id.
 */
export function listActivityLabel(input: {
  activity: ListActivity | null;
  /** The browser's clock when the row's page arrived, or null when unknown. */
  receivedAtMs: number | null;
  /** The browser's clock now. */
  nowMs: number;
}): ListActivityLabel | null {
  const { activity, receivedAtMs, nowMs } = input;
  if (activity === null) {
    return null;
  }
  if (activity.kind === "unclaimed") {
    if (receivedAtMs === null) {
      return null;
    }
    const waited = elapsedMs(
      activity.dueSince,
      serverNowMs({ observedAt: activity.observedAt, receivedAtMs, nowMs })
    );
    return waited < activity.overdueAfterMs
      ? null
      : { text: `Not claimed for ${shortDuration(waited)}`, warns: true };
  }
  const node = activity.nodeName ?? activity.nodeId;
  if (activity.kind === "retrying") {
    return {
      text: node === null ? "Retrying the run" : `Retrying ${node}`,
      warns: false,
    };
  }
  return {
    text:
      node === null
        ? "Worker stopped during the run"
        : `Worker stopped during ${node}`,
    warns: false,
  };
}

/** `1 time`, `2 times`. */
function times(count: number): string {
  return count === 1 ? "1 time" : `${count} times`;
}

/** `1 retry`, `2 retries`. */
function retries(count: number): string {
  return count === 1 ? "1 retry" : `${count} retries`;
}

/**
 * A node's failing step in one sentence: how often it failed, and when the run
 * tries it next and which try that is. A run a worker holds has no next try
 * time, so the sentence stops at the failures.
 */
export function nodeRetrySummary(retry: {
  failures: number;
  retryLimit: number;
  nextTryAt: string | null;
}): string {
  const failed = `Failed ${times(retry.failures)}.`;
  return retry.nextTryAt === null
    ? failed
    : `${failed} Next try at ${clockTimeWithSeconds(retry.nextTryAt)}, try ${retry.failures + 1} of ${retry.retryLimit + 1}.`;
}

/**
 * How a finished execution's retries read, or null for an execution that
 * needed none or did not finish with success or failure.
 */
export function finishedRetriesSummary(execution: {
  status: string;
  retries: number;
}): string | null {
  if (execution.retries === 0) {
    return null;
  }
  if (execution.status === "success") {
    return `Succeeded after ${retries(execution.retries)}`;
  }
  return execution.status === "error"
    ? `Failed after ${retries(execution.retries)}`
    : null;
}
