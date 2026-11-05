/**
 * The replay suites' database-executor drives, run through native SQLite. Each
 * drive opens a database file of its own.
 */

import { describeReplaySuites } from "#src/backend/executor/testing/replay-suites";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";

describeReplaySuites({
  backend: "native SQLite",
  createDatabase: createSqliteTestDatabase,
});
