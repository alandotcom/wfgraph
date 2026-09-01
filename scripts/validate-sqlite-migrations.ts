import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrationsDir = resolve("packages/core/drizzle-sqlite");
const database = new DatabaseSync(":memory:");

const descendingIndexes = new Map<string, readonly [string, number][]>([
  [
    "executions_workflow_started_idx",
    [
      ["workflow_id", 0],
      ["started_at", 1],
      ["id", 1],
    ],
  ],
  [
    "executions_started_idx",
    [
      ["started_at", 1],
      ["id", 1],
    ],
  ],
  [
    "logs_execution_timestamp_idx",
    [
      ["execution_id", 0],
      ["timestamp", 1],
    ],
  ],
  [
    "events_execution_created_idx",
    [
      ["execution_id", 0],
      ["created_at", 1],
    ],
  ],
  [
    "events_workflow_created_idx",
    [
      ["workflow_id", 0],
      ["created_at", 1],
    ],
  ],
]);

try {
  const migrationFiles = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(migrationsDir, entry.name, "migration.sql"))
    .toSorted();

  if (migrationFiles.length === 0) {
    throw new Error("No SQLite migrations found");
  }
  for (const migrationFile of migrationFiles) {
    database.exec(readFileSync(migrationFile, "utf8"));
  }

  const tables = database
    .prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all()
    .map((row) => {
      if (typeof row.name !== "string" || typeof row.sql !== "string") {
        throw new Error("SQLite returned an invalid table definition");
      }
      return { name: row.name, sql: row.sql };
    });
  for (const table of tables) {
    if (!/\) STRICT(?:, WITHOUT ROWID)?$/i.test(table.sql)) {
      throw new Error(`SQLite table ${table.name} is not STRICT`);
    }
  }

  const subscriptions = tables.find(
    (table) => table.name === "workflow_event_subscriptions"
  );
  if (!subscriptions?.sql.match(/\) STRICT, WITHOUT ROWID$/i)) {
    throw new Error(
      "SQLite table workflow_event_subscriptions is not WITHOUT ROWID"
    );
  }

  for (const [indexName, expectedColumns] of descendingIndexes) {
    const columns = database
      .prepare(
        "SELECT name, desc FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno"
      )
      .all(indexName)
      .map((row) => [row.name, row.desc]);
    if (JSON.stringify(columns) !== JSON.stringify(expectedColumns)) {
      throw new Error(`SQLite index ${indexName} lost its sort direction`);
    }
  }
} finally {
  database.close();
}
