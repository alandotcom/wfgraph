/**
 * The executor-state slice of the SQLite `ExecutionRepo`: the same two reads
 * as the PostgreSQL slice in `services/executions/repo/executor-state.ts`,
 * built from the shared pieces in `repo/executor-activity.ts`, over SQLite's
 * encoding.
 */

import { Effect } from "effect";
import { eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { compact } from "es-toolkit/array";
import type { ExecutorStateRepoMethods } from "#src/backend/services/executions/repo/executor-state";
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
import type { ExecutorHold } from "#src/backend/services/executions/repo/contracts";
import type {
  SqliteDatabase,
  SqliteReadExecutor,
} from "#src/backend/persistence/sqlite/database";
import { sqliteExecutionSchedule } from "#src/backend/persistence/sqlite/executions/rows";
import {
  workflowExecutionLogs,
  workflowExecutionSchedule,
  workflowExecutionSteps,
  workflowWaitStates,
} from "#src/backend/persistence/sqlite/schema";

/** The log rows that name the node a pass is running. */
const runningLog = alias(workflowExecutionLogs, "running_log");
/** The log rows that name the node of a failing step. */
const failingLog = alias(workflowExecutionLogs, "failing_log");

/** The holds of `executionIds`: their schedule rows, then those rows' failing steps. */
function readHolds(
  database: SqliteReadExecutor,
  executionIds: readonly string[]
): Effect.Effect<Map<string, ExecutorHold>, unknown> {
  return Effect.gen(function* () {
    if (executionIds.length === 0) return new Map<string, ExecutorHold>();
    const rows = yield* database
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
    if (rows.length === 0) return new Map<string, ExecutorHold>();
    const schedules = rows.map((row) => ({
      schedule: sqliteExecutionSchedule(row.schedule),
      runningNodeName: row.runningNodeName,
    }));
    const failing = yield* database
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
  });
}

export function makeSqliteExecutorStateMethods(
  store: SqliteDatabase
): ExecutorStateRepoMethods {
  return {
    findExecutorState: (executionId) =>
      store.read((database) =>
        Effect.gen(function* () {
          const hold = (yield* readHolds(database, [executionId])).get(
            executionId
          );
          if (hold === undefined) return null;
          const wakes = yield* database
            .select(unconsumedWakeFields(workflowWaitStates))
            .from(workflowWaitStates)
            .where(unconsumedWakesOf(workflowWaitStates, executionId))
            .orderBy(workflowWaitStates.createdAt, workflowWaitStates.id);
          return {
            ...hold,
            unconsumedWakes: wakes.map((wake) => ({
              ...wake,
              kind: parkWakeKind(wake.kind),
              wokenAt: wake.wokenAt === null ? null : new Date(wake.wokenAt),
              deadline: wake.deadline === null ? null : new Date(wake.deadline),
            })),
          };
        })
      ),

    listExecutorHolds: (executionIds) =>
      store.read((database) => readHolds(database, executionIds)),

    listFailingNodeIds: (executionId) =>
      store.read((database) =>
        database
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
          )
          .pipe(Effect.map((rows) => compact(rows.map((row) => row.nodeId))))
      ),
  };
}
