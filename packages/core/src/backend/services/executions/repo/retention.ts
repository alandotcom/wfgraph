/**
 * The run-history retention slice of `ExecutionRepo` over PostgreSQL: ended
 * Executions and workflow-scoped audit rows older than the window, deleted in
 * batches. `retention-policy.ts` decides which rows go; this file runs the
 * statements.
 */

import type { Effect } from "effect";
import {
  workflowEventInbox,
  workflowExecutionEvents,
  workflowExecutions,
} from "#src/backend/lib/db/schema";
import { deleteOldestBatch } from "#src/backend/lib/db/batched-delete";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";
import {
  sweepableExecution,
  sweepableWorkflowAudit,
} from "#src/backend/services/executions/repo/retention-policy";

/** The run-history retention slice of `ExecutionRepo`. */
export type RetentionRepoMethods = {
  /**
   * Delete up to `limit` Executions that hold a terminal status and completed
   * before `olderThan`, oldest completion first, answering how many went. A
   * run stays while the inbox row of the arrival that opened it exists, since
   * a redelivery of that row answers from the run. Each run's node logs, wait
   * rows and run-scoped audit rows go with it by cascade. A terminal run holds
   * no schedule row or step memo, since the write that ended it deleted them.
   */
  readonly sweepEndedExecutions: (input: {
    olderThan: Date;
    limit: number;
  }) => Effect.Effect<number, DatabaseError>;
  /**
   * Delete up to `limit` workflow-scoped audit rows, the ones naming no
   * Execution, written before `olderThan`, oldest first, answering how many
   * went. A row stays while the inbox row its metadata names as `deliveryId`
   * exists, since a redelivery of that row answers from an admission refusal.
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
  const inbox = { table: workflowEventInbox, id: workflowEventInbox.id };
  return {
    sweepEndedExecutions: (input) =>
      database.query((db) =>
        deleteOldestBatch(db, {
          table: workflowExecutions,
          id: workflowExecutions.id,
          where: sweepableExecution(workflowExecutions, inbox, input.olderThan),
          oldestFirst: workflowExecutions.completedAt,
          limit: input.limit,
        })
      ),

    sweepWorkflowAuditEvents: (input) =>
      database.query((db) =>
        deleteOldestBatch(db, {
          table: workflowExecutionEvents,
          id: workflowExecutionEvents.id,
          where: sweepableWorkflowAudit(
            workflowExecutionEvents,
            inbox,
            input.olderThan
          ),
          oldestFirst: workflowExecutionEvents.createdAt,
          limit: input.limit,
        })
      ),
  };
}
