/**
 * The database executor's worker loop cases, run against native SQLite. Each
 * case opens a database file of its own.
 */

import { describeWorkerLoopCases } from "#src/backend/executor/testing/worker-loop-cases";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";

describeWorkerLoopCases({
  backend: "native SQLite",
  createDatabase: createSqliteTestDatabase,
});
