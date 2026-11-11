/**
 * The read side of the database executor for the Runs view: where the
 * executor holds one open run, and where it holds each run of a runs list
 * page. Both read the schedule row and its `failing` memo rows, which exist
 * only while the run is open, so a run that ended answers nothing. Neither
 * takes a lock or decides anything: `executorActivityOf` classifies the facts.
 * `readDueBacklog` counts the rows a claim would lease, for a health check.
 * PostgreSQL keeps leases on its own clock (`lease-clock.ts`), so a hold's
 * `leaseExpiresAt` is answered on the reading process's clock, the clock its
 * caller compares it with.
 */

import {
  type Column,
  count,
  eq,
  inArray,
  min,
  or,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { compact } from "es-toolkit/array";
import {
  workflowExecutionLogs,
  workflowExecutionSchedule,
  workflowExecutionSteps,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { WfGraphDatabase } from "#src/backend/lib/db/index";
import {
  type BoundInstant,
  dueSchedule,
} from "#src/backend/services/executions/repo/release-policy";
import { EXECUTION_SCHEDULE_KINDS } from "@wfgraph/shared/lifecycle/execution-schedule";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import type {
  ExecutorHold,
  ExecutorState,
} from "#src/backend/services/executions/repo/contracts";
import {
  executorHolds,
  failingStepFields,
  failingStepsOf,
  failingNodesOf,
  logOfNode,
  parkWakeKind,
  unconsumedWakeFields,
  unconsumedWakesOf,
} from "#src/backend/services/executions/repo/executor-activity";
import {
  databaseClockOffset,
  onDatabaseClock,
  onProcessClock,
} from "#src/backend/services/executions/repo/lease-clock";

/** The executor-state slice of `ExecutionRepo`. */
export type ExecutorStateRepoMethods = {
  /**
   * Where the executor holds one run, with its unconsumed wakes. Null when the
   * run has no schedule row, which is every run that ended.
   */
  readonly findExecutorState: (
    executionId: string
  ) => Effect.Effect<ExecutorState | null, DatabaseError>;
  /**
   * Where the executor holds each of `executionIds` that has a schedule row,
   * keyed by execution id. The read takes no wait rows. Two queries for the
   * whole set, so a runs list page costs the same however many runs it shows.
   */
  readonly listExecutorHolds: (
    executionIds: readonly string[]
  ) => Effect.Effect<Map<string, ExecutorHold>, DatabaseError>;
  /**
   * The nodes of one run with a step that failed and will run again, each
   * once, in no order. One query, which the status poll makes twice a second.
   * Empty for a run that ended, and for a failing step of no node.
   */
  readonly listFailingNodeIds: (
    executionId: string
  ) => Effect.Effect<string[], DatabaseError>;
  /**
   * How many schedule rows of every kind a claim would lease at `now`, and
   * the earliest `wake_at` among them, or null when none is due. One
   * aggregate query that takes no lock, which a health check runs per probe.
   */
  readonly readDueBacklog: (
    now: Date
  ) => Effect.Effect<DueBacklog, DatabaseError>;
};

/** The schedule rows due at one moment, as `readDueBacklog` counts them. */
export type DueBacklog = {
  readonly due: number;
  readonly oldestWakeAt: Date | null;
};

/**
 * Whether a claim lane of any kind leases this row at `now`, with `leaseNow`
 * the same moment on the clock the backend keeps leases on, as `dueSchedule`
 * takes it.
 */
export function dueOfAnyKind(
  columns: {
    kind: Column;
    state: Column;
    wakeAt: Column;
    leaseExpiresAt: Column;
  },
  now: BoundInstant,
  leaseNow?: BoundInstant
): SQL | undefined {
  return or(
    ...EXECUTION_SCHEDULE_KINDS.map((kind) =>
      dueSchedule(columns, { kind, now, leaseNow })
    )
  );
}

/** The log rows that name the node a pass is running. */
const runningLog = alias(workflowExecutionLogs, "running_log");
/** The log rows that name the node of a failing step. */
const failingLog = alias(workflowExecutionLogs, "failing_log");

/**
 * The holds of `executionIds`: their schedule rows, then those rows' failing
 * steps, with each lease expiry moved onto the process clock by `offsetMs`.
 */
async function readHolds(
  db: WfGraphDatabase,
  executionIds: readonly string[],
  offsetMs: number
): Promise<Map<string, ExecutorHold>> {
  if (executionIds.length === 0) return new Map();
  const schedules = await db
    .select({
      schedule: workflowExecutionSchedule,
      runningNodeName: runningLog.nodeName,
    })
    .from(workflowExecutionSchedule)
    .leftJoin(
      runningLog,
      logOfNode(
        runningLog,
        workflowExecutionSchedule.executionId,
        workflowExecutionSchedule.runningNodeId
      )
    )
    .where(inArray(workflowExecutionSchedule.executionId, [...executionIds]));
  if (schedules.length === 0) return new Map();
  const failing = await db
    .select(failingStepFields(workflowExecutionSteps, failingLog))
    .from(workflowExecutionSteps)
    .innerJoin(
      workflowExecutionSchedule,
      eq(workflowExecutionSchedule.id, workflowExecutionSteps.scheduleId)
    )
    .leftJoin(
      failingLog,
      logOfNode(
        failingLog,
        workflowExecutionSchedule.executionId,
        workflowExecutionSteps.nodeId
      )
    )
    .where(
      failingStepsOf(
        workflowExecutionSteps,
        schedules.map((row) => row.schedule.id)
      )
    );
  return executorHolds(
    schedules.map((row) => ({
      ...row,
      schedule: {
        ...row.schedule,
        leaseExpiresAt:
          row.schedule.leaseExpiresAt === null
            ? null
            : onProcessClock(row.schedule.leaseExpiresAt, offsetMs),
      },
    })),
    failing
  );
}

/** Builds the executor-state slice of `ExecutionRepo` over one database. */
export function makeExecutorStateMethods(
  database: Database["Service"]
): ExecutorStateRepoMethods {
  return {
    findExecutorState: (executionId) =>
      Effect.flatMap(databaseClockOffset(database), (offsetMs) =>
        database.query(async (db): Promise<ExecutorState | null> => {
          const hold = (await readHolds(db, [executionId], offsetMs)).get(
            executionId
          );
          if (hold === undefined) return null;
          const wakes = await db
            .select(unconsumedWakeFields(workflowWaitStates))
            .from(workflowWaitStates)
            .where(unconsumedWakesOf(workflowWaitStates, executionId))
            .orderBy(workflowWaitStates.createdAt, workflowWaitStates.id);
          return {
            ...hold,
            unconsumedWakes: wakes.map((wake) => ({
              ...wake,
              kind: parkWakeKind(wake.kind),
            })),
          };
        })
      ),

    listExecutorHolds: (executionIds) =>
      Effect.flatMap(databaseClockOffset(database), (offsetMs) =>
        database.query((db) => readHolds(db, executionIds, offsetMs))
      ),

    listFailingNodeIds: (executionId) =>
      database.query(async (db) => {
        const rows = await db
          .selectDistinct({ nodeId: workflowExecutionSteps.nodeId })
          .from(workflowExecutionSteps)
          .innerJoin(
            workflowExecutionSchedule,
            eq(workflowExecutionSchedule.id, workflowExecutionSteps.scheduleId)
          )
          .where(
            failingNodesOf(
              workflowExecutionSteps,
              workflowExecutionSchedule,
              executionId
            )
          );
        return compact(rows.map((row) => row.nodeId));
      }),

    readDueBacklog: (now) =>
      Effect.flatMap(databaseClockOffset(database), (offsetMs) =>
        database.query(async (db): Promise<DueBacklog> => {
          const [row] = await db
            .select({
              due: count(),
              oldestWakeAt: min(workflowExecutionSchedule.wakeAt),
            })
            .from(workflowExecutionSchedule)
            .where(
              dueOfAnyKind(
                workflowExecutionSchedule,
                now,
                onDatabaseClock(now, offsetMs)
              )
            );
          return {
            due: row?.due ?? 0,
            oldestWakeAt: row?.oldestWakeAt ?? null,
          };
        })
      ),
  };
}
