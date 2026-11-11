/**
 * Clearing one workflow's run history on SQLite: its runs, and then its
 * workflow-scoped audit rows, `SWEEP_BATCH` rows per write. Each batch is a
 * `BEGIN IMMEDIATE` write of its own, so the one writer is free between
 * batches, and a clear that stops partway leaves whole runs behind for a
 * second call to delete.
 */

import { type SQL, eq, inArray } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import { SWEEP_BATCH } from "#src/backend/services/executions/repo/retention-policy";
import type { SqliteDatabase } from "#src/backend/persistence/sqlite/database";
import {
  workflowExecutionEvents,
  workflowExecutions,
} from "#src/backend/persistence/sqlite/schema";

/**
 * Deletes up to `SWEEP_BATCH` rows of `table` that `where` accepts, in one
 * write, in no particular order, and answers how many went.
 */
function deleteBatch(
  store: SqliteDatabase,
  input: { table: SQLiteTable; id: SQLiteColumn; where: SQL }
) {
  return store.write((database) =>
    database
      .delete(input.table)
      .where(
        inArray(
          input.id,
          database
            .select({ id: input.id })
            .from(input.table)
            .where(input.where)
            .limit(SWEEP_BATCH)
        )
      )
      .returning({ id: input.id })
      .pipe(Effect.map((deleted) => deleted.length))
  );
}

/** Runs `batch` until one deletes fewer than `SWEEP_BATCH`, answering the total. */
function untilDrained<E>(
  batch: Effect.Effect<number, E>
): Effect.Effect<number, E> {
  return Effect.gen(function* () {
    let total = 0;
    for (;;) {
      const deleted = yield* batch;
      total += deleted;
      if (deleted < SWEEP_BATCH) return total;
    }
  });
}

/**
 * Deletes every run of `workflowId` and then every audit row the workflow
 * still holds, answering how many runs went. Node logs, wait rows, schedule
 * rows, step memos and run-scoped audit rows go with each run by cascade, so
 * the audit rows left afterwards are the ones naming no run.
 */
export function deleteWorkflowHistory(
  store: SqliteDatabase,
  workflowId: string
) {
  return Effect.gen(function* () {
    const runs = yield* untilDrained(
      deleteBatch(store, {
        table: workflowExecutions,
        id: workflowExecutions.id,
        where: eq(workflowExecutions.workflowId, workflowId),
      })
    );
    yield* untilDrained(
      deleteBatch(store, {
        table: workflowExecutionEvents,
        id: workflowExecutionEvents.id,
        where: eq(workflowExecutionEvents.workflowId, workflowId),
      })
    );
    return runs;
  });
}
