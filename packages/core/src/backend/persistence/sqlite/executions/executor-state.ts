/**
 * The executor-state slice of the SQLite `ExecutionRepo`: the same two reads
 * as the PostgreSQL slice in `services/executions/repo/executor-state.ts`,
 * which makes the list's decision for both backends, over SQLite's encoding.
 */

import { Effect } from "effect";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  executorActivities,
  type ExecutorStateRepoMethods,
  failingOf,
  failingStepOf,
  parkWakeKind,
} from "#src/backend/services/executions/repo/executor-state";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
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

export function makeSqliteExecutorStateMethods(
  store: SqliteDatabase
): ExecutorStateRepoMethods {
  return {
    findExecutorState: (executionId) =>
      store.read((database) =>
        Effect.gen(function* () {
          const found = yield* database
            .select({
              schedule: workflowExecutionSchedule,
              runningNodeName: runningLog.nodeName,
            })
            .from(workflowExecutionSchedule)
            .leftJoin(
              runningLog,
              and(
                eq(
                  runningLog.executionId,
                  workflowExecutionSchedule.executionId
                ),
                eq(runningLog.nodeId, workflowExecutionSchedule.runningNodeId)
              )
            )
            .where(eq(workflowExecutionSchedule.executionId, executionId))
            .get();
          if (found === undefined) return null;
          const schedule = sqliteExecutionSchedule(found.schedule);
          const failingSteps = yield* database
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
          const wakes = yield* database
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
              wokenAt: wake.wokenAt === null ? null : new Date(wake.wokenAt),
            })),
          };
        })
      ),

    listExecutorActivity: ({ executionIds, now }) =>
      store.read((database) => {
        if (executionIds.length === 0) return Effect.succeed(new Map());
        return database
          .select({
            schedule: workflowExecutionSchedule,
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
          )
          .pipe(
            Effect.map((rows) =>
              executorActivities(
                rows.flatMap((row) => {
                  const schedule = sqliteExecutionSchedule(row.schedule);
                  return schedule.executionId === null
                    ? []
                    : [
                        {
                          executionId: schedule.executionId,
                          state: schedule.state,
                          wakeAt: schedule.wakeAt,
                          attempt: schedule.attempt,
                          leaseExpiresAt: schedule.leaseExpiresAt,
                          runningNodeId: schedule.runningNodeId,
                          runningNodeName: row.runningNodeName,
                          failing: failingOf(row),
                        },
                      ];
                }),
                now
              )
            )
          );
      }),
  };
}
