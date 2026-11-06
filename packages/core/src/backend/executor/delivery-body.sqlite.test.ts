/** The database executor's delivery cases, run against native SQLite. */

import { describeDeliveryCases } from "#src/backend/executor/testing/delivery-cases";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";

describeDeliveryCases({
  backend: "native SQLite",
  createDatabase: createSqliteTestDatabase,
});
