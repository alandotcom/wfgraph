/**
 * The database executor's hold on a run as the Runs view's procedures answer
 * it: `toExecutionSchedule` for one run's logs, `toExecutionActivity` for a
 * runs list row. Every instant is an ISO string, and `observedAt` is the
 * server's clock, which is what the client measures a wait against. Error
 * text passes through the same redaction as a node log's.
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
import { STEP_RETRY_LIMIT } from "#src/backend/services/executions/repo/release-policy";
import {
  IN_FLIGHT_EXECUTION_STATUSES,
  type WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";

/** The node a schedule or an activity names. */
type ExecutorNode = { nodeId: string | null; nodeName: string | null };

/** One run's executor state as `getExecutionLogs` carries it. */
export type ExecutionSchedule = {
  observedAt: string;
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

/** One run's activity as the two list procedures carry it. */
export type ExecutionActivity =
  | (ExecutorNode & {
      kind: "retrying";
      nextTryAt: string;
      failures: number;
      retryLimit: number;
    })
  | (ExecutorNode & { kind: "lease_expired"; since: string })
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

export function toExecutionSchedule(
  state: ExecutorState,
  observedAt: Date
): ExecutionSchedule {
  return {
    observedAt: encodeIsoTimestamp(observedAt),
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
 * page, decided at the server's clock. A run with no activity is absent.
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
      [...activities].map(
        ([executionId, activity]) =>
          [executionId, toExecutionActivity(activity, observedAt)] as const
      )
    );
  }
);

export function toExecutionActivity(
  activity: ExecutorActivity,
  observedAt: Date
): ExecutionActivity {
  switch (activity.kind) {
    case "retrying":
      return {
        kind: "retrying",
        nodeId: activity.nodeId,
        nodeName: activity.nodeName,
        nextTryAt: encodeIsoTimestamp(activity.nextTryAt),
        failures: activity.failures,
        retryLimit: STEP_RETRY_LIMIT,
      };
    case "lease_expired":
      return {
        kind: "lease_expired",
        nodeId: activity.nodeId,
        nodeName: activity.nodeName,
        since: encodeIsoTimestamp(activity.since),
      };
    default:
      return {
        kind: "unclaimed",
        dueSince: encodeIsoTimestamp(activity.dueSince),
        observedAt: encodeIsoTimestamp(observedAt),
      };
  }
}
