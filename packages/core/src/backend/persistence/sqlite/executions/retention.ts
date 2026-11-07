/**
 * The run-history retention slice of the SQLite `ExecutionRepo`, as
 * `RetentionRepoMethods` in `repo/retention.ts` describes it. Each sweep is one
 * `BEGIN IMMEDIATE` write, which holds the one writer, so it needs no
 * `SKIP LOCKED`.
 */

import { Effect } from "effect";
import { asc, inArray } from "drizzle-orm";
import type { RetentionRepoMethods } from "#src/backend/services/executions/repo/retention";
import {
  sweepableExecution,
  sweepableWorkflowAudit,
} from "#src/backend/services/executions/repo/retention-policy";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  workflowEventInbox,
  workflowExecutionEvents,
  workflowExecutions,
} from "#src/backend/persistence/sqlite/schema";

export function makeSqliteRetentionMethods(
  store: SqliteDatabase
): RetentionRepoMethods {
  const inbox = { table: workflowEventInbox, id: workflowEventInbox.id };
  return {
    sweepEndedExecutions: (input) =>
      store.write((database) =>
        database
          .delete(workflowExecutions)
          .where(
            inArray(
              workflowExecutions.id,
              database
                .select({ id: workflowExecutions.id })
                .from(workflowExecutions)
                .where(
                  sweepableExecution(
                    workflowExecutions,
                    inbox,
                    input.olderThan.getTime()
                  )
                )
                .orderBy(asc(workflowExecutions.completedAt))
                .limit(input.limit)
            )
          )
          .returning({ id: workflowExecutions.id })
          .pipe(Effect.map((swept) => swept.length))
      ),

    sweepWorkflowAuditEvents: (input) =>
      store.write((database) =>
        database
          .delete(workflowExecutionEvents)
          .where(
            inArray(
              workflowExecutionEvents.id,
              database
                .select({ id: workflowExecutionEvents.id })
                .from(workflowExecutionEvents)
                .where(
                  sweepableWorkflowAudit(
                    workflowExecutionEvents,
                    inbox,
                    input.olderThan.getTime()
                  )
                )
                .orderBy(asc(workflowExecutionEvents.createdAt))
                .limit(input.limit)
            )
          )
          .returning({ id: workflowExecutionEvents.id })
          .pipe(Effect.map((swept) => swept.length))
      ),
  };
}
