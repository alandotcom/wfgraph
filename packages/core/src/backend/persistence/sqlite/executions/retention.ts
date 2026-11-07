/**
 * The run-history retention slice of the SQLite `ExecutionRepo`, as
 * `RetentionRepoMethods` in `repo/retention.ts` describes it. Each sweep is one
 * `BEGIN IMMEDIATE` write through `deleteOldestBatch`.
 */

import type { RetentionRepoMethods } from "#src/backend/services/executions/repo/retention";
import {
  sweepableExecution,
  sweepableWorkflowAudit,
} from "#src/backend/services/executions/repo/retention-policy";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { deleteOldestBatch } from "#src/backend/persistence/sqlite/batched-delete";
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
        deleteOldestBatch(database, {
          table: workflowExecutions,
          id: workflowExecutions.id,
          where: sweepableExecution(
            workflowExecutions,
            inbox,
            input.olderThan.getTime()
          ),
          oldestFirst: workflowExecutions.completedAt,
          limit: input.limit,
        })
      ),

    sweepWorkflowAuditEvents: (input) =>
      store.write((database) =>
        deleteOldestBatch(database, {
          table: workflowExecutionEvents,
          id: workflowExecutionEvents.id,
          where: sweepableWorkflowAudit(
            workflowExecutionEvents,
            inbox,
            input.olderThan.getTime()
          ),
          oldestFirst: workflowExecutionEvents.createdAt,
          limit: input.limit,
        })
      ),
  };
}
