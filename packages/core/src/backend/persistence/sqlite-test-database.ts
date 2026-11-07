/**
 * A native SQLite database for one case: a file in a temp directory of its own,
 * migrated when the first connection opens and removed by `drop`. Each
 * connection a case opens is a separate SQLite connection to that file.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import {
  conformanceCipher,
  connect,
  type ConformanceDatabase,
} from "#src/backend/persistence/conformance/support";

export async function createSqliteTestDatabase(): Promise<ConformanceDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "wfgraph-sqlite-"));
  const filename = join(directory, "wfgraph.db");

  return {
    open: async (options) =>
      connect(
        await wfSqlite({ filename }).open(options?.cipher ?? conformanceCipher)
      ),
    execute: async (statement) => {
      const database = new DatabaseSync(filename, { timeout: 5_000 });
      try {
        database.exec(
          typeof statement === "string" ? statement : statement.sqlite
        );
      } finally {
        database.close();
      }
    },
    selectIds: async (statement) => {
      const database = new DatabaseSync(filename, { timeout: 5_000 });
      try {
        const rows = database
          .prepare(typeof statement === "string" ? statement : statement.sqlite)
          .all();
        return rows.map((row) => String(Object.values(row)[0]));
      } finally {
        database.close();
      }
    },
    drop: () => rm(directory, { recursive: true, force: true }),
  };
}
