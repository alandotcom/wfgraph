/**
 * The read side of the database executor for the Runs view: where the
 * executor holds one open run, and a compact activity per run for a runs list
 * page. Both read the schedule row, its `failing` memo rows and the run's wait
 * rows, which exist only while the run is open, so a run that ended answers
 * nothing. A node they name is named from the run's log row for it, joined on
 * the run and the node id. Neither read takes a lock. `executorActivityOf`
 * makes the list's decision for both backends.
 */

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Effect } from "effect";
import { maxBy } from "es-toolkit/array";
import {
  workflowExecutionLogs,
  workflowExecutionSchedule,
  workflowExecutionSteps,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import type {
  ExecutionScheduleState,
  ExecutorActivity,
  ExecutorState,
  FailingStep,
  ParkWake,
} from "#src/backend/services/executions/repo/contracts";

/** The executor-state slice of `ExecutionRepo`. */
export type ExecutorStateRepoMethods = {
  /**
   * Where the executor holds one run: its schedule row, its failing steps and
   * its unconsumed wakes. Null when the run has no schedule row, which is
   * every run that ended.
   */
  readonly findExecutorState: (
    executionId: string
  ) => Effect.Effect<ExecutorState | null, DatabaseError>;
  /**
   * The activity of each of `executionIds` that has one at `now`, keyed by
   * execution id, as `executorActivityOf` decides. One query for the whole
   * set, so a runs list page costs one round trip however many runs it shows.
   */
  readonly listExecutorActivity: (input: {
    executionIds: readonly string[];
    now: Date;
  }) => Effect.Effect<Map<string, ExecutorActivity>, DatabaseError>;
};

/** One run's schedule row with one of its failing steps, as the list reads it. */
export type ActivityRow = {
  executionId: string;
  state: ExecutionScheduleState;
  wakeAt: Date;
  attempt: number;
  leaseExpiresAt: Date | null;
  runningNodeId: string | null;
  runningNodeName: string | null;
  /** A failing step of the run, or null when it has none. */
  failing: Pick<FailingStep, "nodeId" | "nodeName" | "failures"> | null;
};

/**
 * What the executor is doing about one run at `now`, from its schedule row
 * and its failing steps (one row per failing step, or one row with none):
 *
 * - a lease that ended at or before `now` is `lease_expired`, the same test a
 *   claim sweeps it by, naming the node the heartbeat last recorded;
 * - a `queued` or `waiting` row due at or before `now` is `unclaimed`;
 * - a `queued` row not yet due after a step's failure is `retrying` that
 *   step, the one with the most failures when several are failing;
 * - a `queued` row not yet due after a failure of the run body is `retrying`
 *   with no node, counting the run's own failures;
 * - anything else (a lease still held, a run asleep on its parks, a row
 *   queued with no failure) has no activity, which answers null.
 */
export function executorActivityOf(
  rows: readonly ActivityRow[],
  now: Date
): ExecutorActivity | null {
  const [row] = rows;
  if (row === undefined) return null;
  const at = now.getTime();
  if (row.state === "leased") {
    return row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() <= at
      ? {
          kind: "lease_expired",
          nodeId: row.runningNodeId,
          nodeName: row.runningNodeName,
          since: row.leaseExpiresAt,
        }
      : null;
  }
  if (row.wakeAt.getTime() <= at) {
    return { kind: "unclaimed", dueSince: row.wakeAt };
  }
  if (row.state !== "queued") return null;
  const failing = maxBy(
    rows.flatMap((candidate) =>
      candidate.failing === null ? [] : [candidate.failing]
    ),
    (step) => step.failures
  );
  if (failing !== undefined) {
    return {
      kind: "retrying",
      nodeId: failing.nodeId,
      nodeName: failing.nodeName,
      nextTryAt: row.wakeAt,
      failures: failing.failures,
    };
  }
  return row.attempt > 0
    ? {
        kind: "retrying",
        nodeId: null,
        nodeName: null,
        nextTryAt: row.wakeAt,
        failures: row.attempt,
      }
    : null;
}

/**
 * The activities `executorActivityOf` decides for every run among `rows`,
 * which hold one row per failing step of each run, keyed by execution id.
 */
export function executorActivities(
  rows: readonly ActivityRow[],
  now: Date
): Map<string, ExecutorActivity> {
  return new Map(
    [...Map.groupBy(rows, (row) => row.executionId)].flatMap(
      ([executionId, runRows]) => {
        const activity = executorActivityOf(runRows, now);
        return activity === null ? [] : [[executionId, activity] as const];
      }
    )
  );
}

/** A failing step as the list's query reads it, with nulls for no step. */
export function failingOf(row: {
  failingNodeId: string | null;
  failingNodeName: string | null;
  failingFailures: number | null;
}): ActivityRow["failing"] {
  return row.failingFailures === null
    ? null
    : {
        nodeId: row.failingNodeId,
        nodeName: row.failingNodeName,
        failures: row.failingFailures,
      };
}

const WAKE_KINDS: readonly ParkWake["kind"][] = [
  "timeout",
  "migrate",
  "cancel",
  "exit",
  "resume",
];

/**
 * A `failing` memo row as `FailingStep`. The table's check keeps a failing
 * row's error set, so a row without one is a defect.
 */
export function failingStepOf(
  row: Omit<FailingStep, "error"> & { error: string | null }
): FailingStep {
  if (row.error === null) {
    throw new Error("A failing step memo row holds no error");
  }
  return { ...row, error: row.error };
}

/** A wake's `kind` as the JSON column holds it. The producers write only these. */
export function parkWakeKind(kind: string | null): ParkWake["kind"] {
  const known = WAKE_KINDS.find((candidate) => candidate === kind);
  if (known === undefined) {
    throw new Error("A wait row holds a wake of no known kind");
  }
  return known;
}

/** The log rows that name the node a pass is running. */
const runningLog = alias(workflowExecutionLogs, "running_log");
/** The log rows that name the node of a failing step. */
const failingLog = alias(workflowExecutionLogs, "failing_log");

/** Builds the executor-state slice of `ExecutionRepo` over one database. */
export function makeExecutorStateMethods(
  database: Database["Service"]
): ExecutorStateRepoMethods {
  return {
    findExecutorState: (executionId) =>
      database.query(async (db): Promise<ExecutorState | null> => {
        const [found] = await db
          .select({
            schedule: workflowExecutionSchedule,
            runningNodeName: runningLog.nodeName,
          })
          .from(workflowExecutionSchedule)
          .leftJoin(
            runningLog,
            and(
              eq(runningLog.executionId, workflowExecutionSchedule.executionId),
              eq(runningLog.nodeId, workflowExecutionSchedule.runningNodeId)
            )
          )
          .where(eq(workflowExecutionSchedule.executionId, executionId))
          .limit(1);
        if (found === undefined) return null;
        const { schedule } = found;
        const failingSteps = await db
          .select({
            stepId: workflowExecutionSteps.stepId,
            nodeId: workflowExecutionSteps.nodeId,
            nodeName: failingLog.nodeName,
            failures: workflowExecutionSteps.failures,
            error: workflowExecutionSteps.error,
          })
          .from(workflowExecutionSteps)
          .leftJoin(
            failingLog,
            and(
              eq(failingLog.executionId, executionId),
              eq(failingLog.nodeId, workflowExecutionSteps.nodeId)
            )
          )
          .where(
            and(
              eq(workflowExecutionSteps.scheduleId, schedule.id),
              eq(workflowExecutionSteps.status, "failing")
            )
          )
          .orderBy(
            desc(workflowExecutionSteps.failures),
            workflowExecutionSteps.stepId
          );
        // The wake's payload is an arbitrary Event body, so only the two
        // fields the view names are read out of it.
        const wakes = await db
          .select({
            waitStateId: workflowWaitStates.id,
            nodeId: workflowWaitStates.nodeId,
            nodeName: workflowWaitStates.nodeName,
            kind: sql<string | null>`${workflowWaitStates.wake} ->> 'kind'`,
            eventName: sql<
              string | null
            >`${workflowWaitStates.wake} ->> 'eventName'`,
            wokenAt: workflowWaitStates.resumedAt,
          })
          .from(workflowWaitStates)
          .where(
            and(
              eq(workflowWaitStates.executionId, executionId),
              eq(workflowWaitStates.status, "resuming"),
              isNotNull(workflowWaitStates.wake)
            )
          )
          .orderBy(workflowWaitStates.createdAt, workflowWaitStates.id);
        return {
          state: schedule.state,
          wakeAt: schedule.wakeAt,
          attempt: schedule.attempt,
          runningStepId: schedule.runningStepId,
          runningNodeId: schedule.runningNodeId,
          runningNodeName: found.runningNodeName,
          leaseExpiresAt: schedule.leaseExpiresAt,
          workerId: schedule.workerId,
          lastError: schedule.lastError,
          failingSteps: failingSteps.map(failingStepOf),
          unconsumedWakes: wakes.map((wake) => ({
            ...wake,
            kind: parkWakeKind(wake.kind),
          })),
        };
      }),

    listExecutorActivity: ({ executionIds, now }) =>
      database.query(async (db) => {
        if (executionIds.length === 0) return new Map();
        const rows = await db
          .select({
            executionId: workflowExecutionSchedule.executionId,
            state: workflowExecutionSchedule.state,
            wakeAt: workflowExecutionSchedule.wakeAt,
            attempt: workflowExecutionSchedule.attempt,
            leaseExpiresAt: workflowExecutionSchedule.leaseExpiresAt,
            runningNodeId: workflowExecutionSchedule.runningNodeId,
            runningNodeName: runningLog.nodeName,
            failingNodeId: workflowExecutionSteps.nodeId,
            failingNodeName: failingLog.nodeName,
            failingFailures: workflowExecutionSteps.failures,
          })
          .from(workflowExecutionSchedule)
          .leftJoin(
            workflowExecutionSteps,
            and(
              eq(
                workflowExecutionSteps.scheduleId,
                workflowExecutionSchedule.id
              ),
              eq(workflowExecutionSteps.status, "failing")
            )
          )
          .leftJoin(
            runningLog,
            and(
              eq(runningLog.executionId, workflowExecutionSchedule.executionId),
              eq(runningLog.nodeId, workflowExecutionSchedule.runningNodeId)
            )
          )
          .leftJoin(
            failingLog,
            and(
              eq(failingLog.executionId, workflowExecutionSchedule.executionId),
              eq(failingLog.nodeId, workflowExecutionSteps.nodeId)
            )
          )
          .where(
            inArray(workflowExecutionSchedule.executionId, [...executionIds])
          );
        return executorActivities(
          rows.flatMap((row) =>
            row.executionId === null
              ? []
              : [
                  {
                    executionId: row.executionId,
                    state: row.state,
                    wakeAt: row.wakeAt,
                    attempt: row.attempt,
                    leaseExpiresAt: row.leaseExpiresAt,
                    runningNodeId: row.runningNodeId,
                    runningNodeName: row.runningNodeName,
                    failing: failingOf(row),
                  },
                ]
          ),
          now
        );
      }),
  };
}
