/**
 * The one statement each SQLite retention sweep runs, as `deleteOldestBatch`
 * in `lib/db/batched-delete.ts` runs it on PostgreSQL. A SQLite write holds
 * the one writer from its first statement, so it takes no row locks.
 */

import { type SQL, asc, inArray } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import type { SqliteExecutor } from "#src/backend/persistence/sqlite/database";

/**
 * Deletes up to `limit` rows of `table` that `where` accepts, in ascending
 * order of `oldestFirst`, and answers how many went.
 */
export function deleteOldestBatch(
  database: SqliteExecutor,
  input: {
    table: SQLiteTable;
    id: SQLiteColumn;
    where: SQL;
    oldestFirst: SQLiteColumn;
    limit: number;
  }
) {
  return database
    .delete(input.table)
    .where(
      inArray(
        input.id,
        database
          .select({ id: input.id })
          .from(input.table)
          .where(input.where)
          .orderBy(asc(input.oldestFirst))
          .limit(input.limit)
      )
    )
    .returning({ id: input.id })
    .pipe(Effect.map((deleted) => deleted.length));
}
