/**
 * The read side of the database executor for the Runs view: where the
 * executor holds one open run, and where it holds each run of a runs list
 * page. Both read the schedule row and its `failing` memo rows, which exist
 * only while the run is open, so a run that ended answers nothing. Neither
 * takes a lock or decides anything: `executorActivityOf` classifies the facts.
 */

import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Effect } from "effect";
import {
  workflowExecutionLogs,
  workflowExecutionSchedule,
  workflowExecutionSteps,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import type { WfGraphDatabase } from "#src/backend/lib/db/index";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import type {
  ExecutorHold,
  ExecutorState,
} from "#src/backend/services/executions/repo/contracts";
import {
  executorHolds,
  failingStepFields,
  failingStepsOf,
  logOfNode,
  parkWakeKind,
  unconsumedWakeFields,
  unconsumedWakesOf,
} from "#src/backend/services/executions/repo/executor-activity";

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
};

/** The log rows that name the node a pass is running. */
const runningLog = alias(workflowExecutionLogs, "running_log");
/** The log rows that name the node of a failing step. */
const failingLog = alias(workflowExecutionLogs, "failing_log");

/** The holds of `executionIds`: their schedule rows, then those rows' failing steps. */
async function readHolds(
  db: WfGraphDatabase,
  executionIds: readonly string[]
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
  return executorHolds(schedules, failing);
}

/** Builds the executor-state slice of `ExecutionRepo` over one database. */
export function makeExecutorStateMethods(
  database: Database["Service"]
): ExecutorStateRepoMethods {
  return {
    findExecutorState: (executionId) =>
      database.query(async (db): Promise<ExecutorState | null> => {
        const hold = (await readHolds(db, [executionId])).get(executionId);
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
      }),

    listExecutorHolds: (executionIds) =>
      database.query((db) => readHolds(db, executionIds)),
  };
}
