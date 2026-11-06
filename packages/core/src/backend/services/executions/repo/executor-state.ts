/**
 * The read side of the database executor for the Runs view: where the
 * executor holds one open run, and a compact activity per run for a runs list
 * page. Both read the schedule row, its `failing` memo rows and the run's wait
 * rows, which exist only while the run is open, so a run that ended answers
 * nothing. A node they name is named from the run's log row for it, joined on
 * the run and the node id. Neither read takes a lock. `executorActivityOf`
 * decides what the executor is doing about a run, for both reads and both
 * backends.
 */

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Effect, Schema } from "effect";
import { compact, maxBy } from "es-toolkit/array";
import { omit } from "es-toolkit/object";
import {
  workflowExecutionLogs,
  workflowExecutionSchedule,
  workflowExecutionSteps,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import type {
  ExecutorActivity,
  ExecutorState,
  FailingStep,
  ParkWake,
  UnconsumedWake,
} from "#src/backend/services/executions/repo/contracts";
import { PARK_WAKE_KINDS } from "@wfgraph/shared/lifecycle/execution-schedule";
import { readAs } from "@wfgraph/shared/types/schema";

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
   * execution id, as `executorActivityOf` decides from the run's schedule row
   * and failing steps. The read takes no wait rows, so it never answers
   * `resuming`: a producer that resolves a park also makes the run due, and
   * the run reads as `unclaimed` until a worker claims it. One query for the
   * whole set, so a runs list page costs one round trip however many runs it
   * shows.
   */
  readonly listExecutorActivity: (input: {
    executionIds: readonly string[];
    now: Date;
  }) => Effect.Effect<Map<string, ExecutorActivity>, DatabaseError>;
};

/**
 * The facts `executorActivityOf` decides from: a run's schedule row, its
 * failing steps in any order, and its unconsumed wakes, oldest first.
 * `ExecutorState` is one.
 */
export type ExecutorHold = Pick<
  ExecutorState,
  | "state"
  | "wakeAt"
  | "attempt"
  | "leaseExpiresAt"
  | "workerId"
  | "runningNodeId"
  | "runningNodeName"
  | "lastError"
> & {
  failingSteps: ReadonlyArray<
    Pick<FailingStep, "nodeId" | "nodeName" | "failures" | "error">
  >;
  unconsumedWakes: readonly UnconsumedWake[];
};

/** One run's schedule row with one of its failing steps, as the list reads it. */
export type ActivityRow = Omit<
  ExecutorHold,
  "failingSteps" | "unconsumedWakes"
> & {
  executionId: string;
  /** A failing step of the run, or null when it has none. */
  failing: ExecutorHold["failingSteps"][number] | null;
};

/**
 * What the executor is doing about one run at `now`, as `ExecutorActivity`
 * describes each case, taking the first that holds:
 *
 * 1. an unconsumed wake is `resuming`, naming the oldest when there are several;
 * 2. a lease that ended at or before `now` is `lease_expired`, the same test a
 *    claim sweeps it by, and a lease still held is `running`;
 * 3. a `queued` row not yet due after a step's failure is `retrying` that
 *    step, the one with the most failures when several are failing, and after
 *    a failure of the run body (`attempt` above zero) it is `retrying` with no
 *    node;
 * 4. a `queued` or `waiting` row due at or before `now` is `unclaimed`;
 * 5. a `waiting` row not yet due is `waiting`.
 *
 * A `queued` row not yet due with no failure has no activity, which answers
 * null.
 */
export function executorActivityOf(
  hold: ExecutorHold,
  now: Date
): ExecutorActivity | null {
  const at = now.getTime();
  const [wake] = hold.unconsumedWakes;
  if (wake !== undefined) {
    return {
      kind: "resuming",
      nodeId: wake.nodeId,
      nodeName: wake.nodeName,
      wake: wake.kind,
      eventName: wake.eventName,
      wokenAt: wake.wokenAt,
      deadline: wake.deadline,
      unclaimedSince:
        hold.state === "leased" ? null : (wake.wokenAt ?? hold.wakeAt),
    };
  }
  if (hold.state === "leased") {
    return hold.leaseExpiresAt !== null && hold.leaseExpiresAt.getTime() <= at
      ? {
          kind: "lease_expired",
          nodeId: hold.runningNodeId,
          nodeName: hold.runningNodeName,
          since: hold.leaseExpiresAt,
        }
      : {
          kind: "running",
          nodeId: hold.runningNodeId,
          nodeName: hold.runningNodeName,
          workerId: hold.workerId,
        };
  }
  const due = hold.wakeAt.getTime() <= at;
  if (hold.state === "queued" && !due) {
    const failing = maxBy(hold.failingSteps, (step) => step.failures);
    if (failing !== undefined) {
      return {
        kind: "retrying",
        nodeId: failing.nodeId,
        nodeName: failing.nodeName,
        nextTryAt: hold.wakeAt,
        failures: failing.failures,
        error: failing.error,
      };
    }
    return hold.attempt > 0
      ? {
          kind: "retrying",
          nodeId: null,
          nodeName: null,
          nextTryAt: hold.wakeAt,
          failures: hold.attempt,
          error: hold.lastError,
        }
      : null;
  }
  return due
    ? { kind: "unclaimed", dueSince: hold.wakeAt }
    : { kind: "waiting" };
}

/**
 * The activities `executorActivityOf` decides for every run among `rows`,
 * which hold one row per failing step of each run, keyed by execution id.
 * The rows carry no wakes, as `listExecutorActivity` describes.
 */
export function executorActivities(
  rows: readonly ActivityRow[],
  now: Date
): Map<string, ExecutorActivity> {
  return new Map(
    [...Map.groupBy(rows, (row) => row.executionId)].flatMap(
      ([executionId, [first, ...rest]]) => {
        if (first === undefined) return [];
        const activity = executorActivityOf(
          {
            ...omit(first, ["executionId", "failing"]),
            failingSteps: compact([first, ...rest].map((row) => row.failing)),
            unconsumedWakes: [],
          },
          now
        );
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
  failingError: string | null;
}): ActivityRow["failing"] {
  return row.failingFailures === null
    ? null
    : failingStepOf({
        nodeId: row.failingNodeId,
        nodeName: row.failingNodeName,
        failures: row.failingFailures,
        error: row.failingError,
      });
}

const readParkWakeKind = readAs(Schema.Literals(PARK_WAKE_KINDS));

/**
 * A `failing` memo row's columns with the error narrowed to a string. The
 * table's check keeps a failing row's error set, so a row without one is a
 * defect.
 */
export function failingStepOf<Row extends { error: string | null }>(
  row: Row
): Omit<Row, "error"> & { error: string } {
  if (row.error === null) {
    throw new Error("A failing step memo row holds no error");
  }
  return { ...row, error: row.error };
}

/** A wake's `kind` as the JSON column holds it. The producers write only these. */
export function parkWakeKind(kind: string | null): ParkWake["kind"] {
  const known = readParkWakeKind(kind);
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
            deadline: workflowWaitStates.waitUntil,
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
            workerId: workflowExecutionSchedule.workerId,
            lastError: workflowExecutionSchedule.lastError,
            runningNodeId: workflowExecutionSchedule.runningNodeId,
            runningNodeName: runningLog.nodeName,
            failingNodeId: workflowExecutionSteps.nodeId,
            failingNodeName: failingLog.nodeName,
            failingFailures: workflowExecutionSteps.failures,
            failingError: workflowExecutionSteps.error,
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
                    workerId: row.workerId,
                    lastError: row.lastError,
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
