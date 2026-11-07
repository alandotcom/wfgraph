/**
 * The one statement each PostgreSQL retention sweep runs: delete a bounded
 * batch of rows, oldest first, and answer how many went. The sweep's policy
 * module decides which rows qualify; this runs the delete.
 */

import { type SQL, asc, inArray } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { WfGraphDatabase } from "#src/backend/lib/db/index";

/**
 * Deletes up to `limit` rows of `table` that `where` accepts, in ascending
 * order of `oldestFirst`, and answers how many went.
 *
 * The rows are chosen `FOR UPDATE SKIP LOCKED`. Two sweeps that overlap, such
 * as two Workers' Cron Trigger ticks, each take the rows the other has not
 * locked, and a row another transaction holds, such as a run an audit insert
 * names, waits for the next sweep. Taking the lock rechecks the row's own
 * columns in `where` against its latest committed version, so a row a
 * concurrent write moved out of the batch's bound is dropped.
 */
export async function deleteOldestBatch(
  db: WfGraphDatabase,
  input: {
    table: PgTable;
    id: PgColumn;
    where: SQL;
    oldestFirst: PgColumn;
    limit: number;
  }
): Promise<number> {
  const deleted = await db
    .delete(input.table)
    .where(
      inArray(
        input.id,
        db
          .select({ id: input.id })
          .from(input.table)
          .where(input.where)
          .orderBy(asc(input.oldestFirst))
          .limit(input.limit)
          .for("update", { skipLocked: true })
      )
    )
    .returning({ id: input.id });
  return deleted.length;
}
