/**
 * The database executor's hold on a run as the Runs view's procedures answer
 * it, in the wire shapes `@wfgraph/shared/rpc/contracts/workflows` declares:
 * `toExecutorStateView` for one run's logs and `readRunListActivities` for a
 * runs list page, each classified here by `executorActivityOf`. The list reads
 * no wake rows, so it never decides `resuming`.
 */

import { Clock, Effect } from "effect";
import {
  DEFAULT_OVERDUE_AFTER_MS,
  WfGraphAppContext,
} from "#src/backend/lib/effect/app-context";
import { redactSensitiveText } from "#src/backend/lib/utils/redact";
import {
  ExecutionRepo,
  type ExecutorActivity,
  type ExecutorState,
} from "#src/backend/services/executions/repo";
import { executorActivityOf } from "#src/backend/services/executions/repo/executor-activity";
import { STEP_RETRY_LIMIT } from "#src/backend/services/executions/repo/release-policy";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type {
  ExecutorStateView,
  RunListActivityView,
} from "@wfgraph/shared/rpc/contracts/workflows";
import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";

/** What the overview's activity can be: one case of `ExecutorStateView`. */
type ScheduleActivityView = NonNullable<ExecutorStateView["activity"]>;

/**
 * How often the Worker host's Cron Trigger runs a tick. A Queue wakes a run a
 * producer made due at once, but a park's deadline is found only by the Cron
 * Trigger's tick, so the Worker host waits for two of them either way.
 */
const WORKER_CRON_INTERVAL_MS = 60_000;

/**
 * How long a due run may wait for a worker on a host before the Runs view
 * says no worker has claimed it. `pollMs` is how often the host's worker loop
 * polls, and undefined for the Worker host, whose Cron Trigger runs a tick a
 * minute. Two polls or two ticks, and never under `DEFAULT_OVERDUE_AFTER_MS`,
 * since a worker loop at its default poll looks for due runs many times in a
 * minute.
 */
export function overdueAfterMs(pollMs: number | undefined): number {
  return Math.max(
    DEFAULT_OVERDUE_AFTER_MS,
    2 * (pollMs ?? WORKER_CRON_INTERVAL_MS)
  );
}

const IN_FLIGHT: ReadonlySet<WorkflowExecutionStatus> = new Set(
  IN_FLIGHT_EXECUTION_STATUSES
);

/**
 * Whether the executor may hold a run in `status`. A run in any other status
 * has ended, its schedule row is gone, and the reads are skipped for it.
 */
export function heldByExecutor(status: WorkflowExecutionStatus): boolean {
  return IN_FLIGHT.has(status);
}

/**
 * The server's clock, which every executor read is decided at, and the reading
 * an answer carries beside the activities it decided: that clock as an ISO
 * string and the host's `overdueAfterMs`.
 */
export const executorReading = Effect.gen(function* () {
  const { overdueAfterMs: overdue } = yield* WfGraphAppContext;
  const now = new Date(yield* Clock.currentTimeMillis);
  return {
    now,
    reading: { observedAt: encodeIsoTimestamp(now), overdueAfterMs: overdue },
  };
});

function optionalInstant(value: Date | null): string | null {
  return value === null ? null : encodeIsoTimestamp(value);
}

function toScheduleActivity(activity: ExecutorActivity): ScheduleActivityView {
  switch (activity.kind) {
    case "resuming":
      return {
        ...activity,
        wokenAt: optionalInstant(activity.wokenAt),
        deadline: optionalInstant(activity.deadline),
        unclaimedSince: optionalInstant(activity.unclaimedSince),
      };
    case "lease_expired":
      return { ...activity, since: encodeIsoTimestamp(activity.since) };
    case "running":
      return activity;
    case "retrying":
      return {
        ...activity,
        nextTryAt: encodeIsoTimestamp(activity.nextTryAt),
        retryLimit: STEP_RETRY_LIMIT,
        error: redactSensitiveText(activity.error),
      };
    case "unclaimed":
      return {
        kind: "unclaimed",
        dueSince: encodeIsoTimestamp(activity.dueSince),
      };
    default:
      return activity;
  }
}

/** `state` as `getExecutionLogs` answers it, decided at `now`. */
export function toExecutorStateView(input: {
  state: ExecutorState;
  now: Date;
  reading: { observedAt: string; overdueAfterMs: number };
}): ExecutorStateView {
  const { state, now, reading } = input;
  const activity = executorActivityOf({
    hold: state,
    wakes: state.unconsumedWakes,
    now,
  });
  // Every failing step runs again on the run's next pass, so while the run
  // waits out a retry, that pass is each step's next try.
  const nextTryAt =
    activity?.kind === "retrying"
      ? encodeIsoTimestamp(activity.nextTryAt)
      : null;
  return {
    ...reading,
    activity: activity === null ? null : toScheduleActivity(activity),
    state: state.state,
    wakeAt: encodeIsoTimestamp(state.wakeAt),
    attempt: state.attempt,
    retryLimit: STEP_RETRY_LIMIT,
    runningStepId: state.runningStepId,
    leaseExpiresAt: optionalInstant(state.leaseExpiresAt),
    workerId: state.workerId,
    failingSteps: state.failingSteps.map((step) => ({
      nodeId: step.nodeId,
      failures: step.failures,
      error: redactSensitiveText(step.error),
      nextTryAt,
    })),
  };
}

/**
 * `activity` as a runs list row carries it, and null for a case the row does
 * not show (`running`, `waiting`, and `resuming`, which the list's read never
 * decides).
 */
function toRunListActivity(
  activity: ExecutorActivity
): RunListActivityView | null {
  const shown = toScheduleActivity(activity);
  switch (shown.kind) {
    case "retrying":
    case "lease_expired":
    case "unclaimed":
      return shown;
    default:
      return null;
  }
}

/**
 * The activity of each run among `rows` the executor holds, as the list
 * procedures carry it, keyed by execution id: one repository read for the
 * page, decided at `now`. A run with no activity, or with one a list row does
 * not show, is absent.
 */
export const readRunListActivities = Effect.fn("readRunListActivities")(
  function* (
    rows: ReadonlyArray<{ id: string; status: WorkflowExecutionStatus }>,
    now: Date
  ) {
    const executionIds = rows
      .filter((row) => heldByExecutor(row.status))
      .map((row) => row.id);
    // A page of ended runs has nothing the executor holds to ask about.
    if (executionIds.length === 0)
      return new Map<string, RunListActivityView>();
    const repo = yield* ExecutionRepo;
    const holds = yield* repo.listExecutorHolds(executionIds);
    return new Map(
      [...holds].flatMap(([executionId, hold]) => {
        // The list reads no wake rows, so it never decides `resuming`: a
        // producer that resolves a park also makes the run due, and the run
        // reads as `unclaimed` until a worker claims it.
        const activity = executorActivityOf({ hold, wakes: [], now });
        const shown = activity === null ? null : toRunListActivity(activity);
        return shown === null ? [] : [[executionId, shown] as const];
      })
    );
  }
);
