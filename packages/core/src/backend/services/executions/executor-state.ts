/**
 * The database executor's hold on a run as the Runs view's procedures answer
 * it: `toExecutionSchedule` for one run's logs, `toExecutionActivity` for a
 * runs list row. Both carry what `executorActivityOf` decided, so the overview
 * and the list never disagree about a run. Every instant is an ISO string, and
 * `observedAt` is the server's clock, which is what the client measures a wait
 * against. Error text passes through the same redaction as a node log's.
 */

import { Clock, Effect } from "effect";
import { redactSensitiveText } from "#src/backend/lib/utils/redact";
import {
  ExecutionRepo,
  type ExecutionScheduleState,
  type ExecutorActivity,
  type ExecutorState,
  type ParkWake,
} from "#src/backend/services/executions/repo";
import { executorActivityOf } from "#src/backend/services/executions/repo/executor-state";
import { STEP_RETRY_LIMIT } from "#src/backend/services/executions/repo/release-policy";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";

/** The node a schedule or an activity names. */
type ExecutorNode = { nodeId: string | null; nodeName: string | null };

/**
 * What the executor is doing about one run, as `ExecutorActivity` describes
 * each case, with every instant an ISO string and a retry carrying the
 * executor's retry limit.
 */
export type ScheduleActivity =
  | {
      kind: "resuming";
      nodeId: string;
      nodeName: string;
      wake: ParkWake["kind"];
      eventName: string | null;
      wokenAt: string | null;
      deadline: string | null;
      unclaimedSince: string | null;
    }
  | (ExecutorNode & { kind: "lease_expired"; since: string })
  | (ExecutorNode & { kind: "running"; workerId: string | null })
  | (ExecutorNode & {
      kind: "retrying";
      nextTryAt: string;
      failures: number;
      retryLimit: number;
      error: string | null;
    })
  | { kind: "unclaimed"; dueSince: string }
  | { kind: "waiting" };

/** One run's executor state as `getExecutionLogs` carries it. */
export type ExecutionSchedule = {
  observedAt: string;
  activity: ScheduleActivity | null;
  state: ExecutionScheduleState;
  wakeAt: string;
  attempt: number;
  retryLimit: number;
  runningStepId: string | null;
  runningNodeId: string | null;
  runningNodeName: string | null;
  leaseExpiresAt: string | null;
  workerId: string | null;
  lastError: string | null;
  failingSteps: Array<
    ExecutorNode & { stepId: string; failures: number; error: string }
  >;
  unconsumedWakes: Array<{
    waitStateId: string;
    nodeId: string;
    nodeName: string;
    kind: ParkWake["kind"];
    eventName: string | null;
    wokenAt: string | null;
  }>;
};

/**
 * One run's activity as the two list procedures carry it: the three cases a
 * runs list row shows, with `observedAt` on `unclaimed` so the client can
 * measure how long the run has waited against the server's clock.
 */
export type ExecutionActivity =
  | Extract<ScheduleActivity, { kind: "retrying" | "lease_expired" }>
  | { kind: "unclaimed"; dueSince: string; observedAt: string };

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

/** The server's clock, which every executor read is decided and reported at. */
export const observedNow = Effect.map(
  Clock.currentTimeMillis,
  (millis) => new Date(millis)
);

function optionalInstant(value: Date | null): string | null {
  return value === null ? null : encodeIsoTimestamp(value);
}

function toScheduleActivity(activity: ExecutorActivity): ScheduleActivity {
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

export function toExecutionSchedule(
  state: ExecutorState,
  observedAt: Date
): ExecutionSchedule {
  const activity = executorActivityOf(state, observedAt);
  return {
    observedAt: encodeIsoTimestamp(observedAt),
    activity: activity === null ? null : toScheduleActivity(activity),
    state: state.state,
    wakeAt: encodeIsoTimestamp(state.wakeAt),
    attempt: state.attempt,
    retryLimit: STEP_RETRY_LIMIT,
    runningStepId: state.runningStepId,
    runningNodeId: state.runningNodeId,
    runningNodeName: state.runningNodeName,
    leaseExpiresAt: optionalInstant(state.leaseExpiresAt),
    workerId: state.workerId,
    lastError: redactSensitiveText(state.lastError),
    failingSteps: state.failingSteps.map((step) => ({
      stepId: step.stepId,
      nodeId: step.nodeId,
      nodeName: step.nodeName,
      failures: step.failures,
      error: redactSensitiveText(step.error),
    })),
    unconsumedWakes: state.unconsumedWakes.map((wake) => ({
      waitStateId: wake.waitStateId,
      nodeId: wake.nodeId,
      nodeName: wake.nodeName,
      kind: wake.kind,
      eventName: wake.eventName,
      wokenAt: optionalInstant(wake.wokenAt),
    })),
  };
}

/**
 * The activity of each run among `rows` the executor holds, as the list
 * procedures carry it, keyed by execution id: one repository read for the
 * page, decided at the server's clock. A run with no activity, or with one a
 * list row does not show, is absent.
 */
export const readExecutionActivities = Effect.fn("readExecutionActivities")(
  function* (
    rows: ReadonlyArray<{ id: string; status: WorkflowExecutionStatus }>
  ) {
    const executionIds = rows
      .filter((row) => heldByExecutor(row.status))
      .map((row) => row.id);
    // A page of ended runs has nothing the executor holds to ask about.
    if (executionIds.length === 0) return new Map<string, ExecutionActivity>();
    const repo = yield* ExecutionRepo;
    const observedAt = yield* observedNow;
    const activities = yield* repo.listExecutorActivity({
      executionIds,
      now: observedAt,
    });
    return new Map(
      [...activities].flatMap(([executionId, activity]) => {
        const shown = toExecutionActivity(activity, observedAt);
        return shown === null ? [] : [[executionId, shown] as const];
      })
    );
  }
);

/**
 * `activity` as a runs list row carries it, and null for a case the row does
 * not show (`running`, `waiting`, and `resuming`, which the list's read never
 * decides).
 */
export function toExecutionActivity(
  activity: ExecutorActivity,
  observedAt: Date
): ExecutionActivity | null {
  const shown = toScheduleActivity(activity);
  switch (shown.kind) {
    case "retrying":
    case "lease_expired":
      return shown;
    case "unclaimed":
      return { ...shown, observedAt: encodeIsoTimestamp(observedAt) };
    default:
      return null;
  }
}
