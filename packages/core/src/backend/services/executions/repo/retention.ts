/**
 * The run-history retention slice of `ExecutionRepo` over PostgreSQL: ended
 * Executions and workflow-scoped audit rows older than the window, deleted in
 * batches. `retention-policy.ts` decides which rows go; this file runs the
 * statements.
 */

import { asc, inArray } from "drizzle-orm";
import type { Effect } from "effect";
import {
  workflowExecutionEvents,
  workflowExecutions,
} from "#src/backend/lib/db/schema";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import {
  sweepableExecution,
  sweepableWorkflowAudit,
} from "#src/backend/services/executions/repo/retention-policy";

/** The run-history retention slice of `ExecutionRepo`. */
export type RetentionRepoMethods = {
  /**
   * Delete up to `limit` Executions that hold a terminal status and completed
   * before `olderThan`, oldest completion first, answering how many went. Each
   * run's node logs, wait rows and run-scoped audit rows go with it by
   * cascade. A terminal run holds no schedule row or step memo, since the
   * write that ended it deleted them.
   */
  readonly sweepEndedExecutions: (input: {
    olderThan: Date;
    limit: number;
  }) => Effect.Effect<number, DatabaseError>;
  /**
   * Delete up to `limit` workflow-scoped audit rows, the ones naming no
   * Execution, written before `olderThan`, oldest first, answering how many
   * went.
   */
  readonly sweepWorkflowAuditEvents: (input: {
    olderThan: Date;
    limit: number;
  }) => Effect.Effect<number, DatabaseError>;
};

/** Builds the run-history retention slice of `ExecutionRepo` over one database. */
export function makeRetentionMethods(
  database: Database["Service"]
): RetentionRepoMethods {
  return {
    sweepEndedExecutions: (input) =>
      database.query(async (db) => {
        const swept = await db
          .delete(workflowExecutions)
          .where(
            inArray(
              workflowExecutions.id,
              db
                .select({ id: workflowExecutions.id })
                .from(workflowExecutions)
                .where(sweepableExecution(workflowExecutions, input.olderThan))
                .orderBy(asc(workflowExecutions.completedAt))
                .limit(input.limit)
                // Two sweeps that overlap, such as two Workers' Cron Trigger
                // ticks, each take the rows the other has not locked. A run
                // whose row another transaction holds, such as an audit insert
                // naming it, waits for the next sweep.
                .for("update", { skipLocked: true })
            )
          )
          .returning({ id: workflowExecutions.id });
        return swept.length;
      }),

    sweepWorkflowAuditEvents: (input) =>
      database.query(async (db) => {
        const swept = await db
          .delete(workflowExecutionEvents)
          .where(
            inArray(
              workflowExecutionEvents.id,
              db
                .select({ id: workflowExecutionEvents.id })
                .from(workflowExecutionEvents)
                .where(
                  sweepableWorkflowAudit(
                    workflowExecutionEvents,
                    input.olderThan
                  )
                )
                .orderBy(asc(workflowExecutionEvents.createdAt))
                .limit(input.limit)
                .for("update", { skipLocked: true })
            )
          )
          .returning({ id: workflowExecutionEvents.id });
        return swept.length;
      }),
  };
}
