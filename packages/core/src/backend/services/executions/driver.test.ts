/**
 * The database execution driver's cases, run against native SQLite. Each case
 * opens a database file of its own.
 */

import { describeExecutionDriverCases } from "#src/backend/services/executions/testing/driver-cases";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";

describeExecutionDriverCases({
  backend: "native SQLite",
  createDatabase: createSqliteTestDatabase,
  crossProcess: false,
});
