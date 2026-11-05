/**
 * The database executor's pass cases, run against native SQLite. Each case
 * opens a database file of its own.
 */

import { describePassCases } from "#src/backend/executor/testing/pass-cases";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";

describePassCases({
  backend: "native SQLite",
  createDatabase: createSqliteTestDatabase,
});
