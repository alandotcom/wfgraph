/**
 * The shared repository contract is answered by native SQLite. A database is one
 * temp directory. Cases reaching into SQLite's own storage live beside this
 * file.
 */

import { describePersistenceConformance } from "#src/backend/persistence/persistence-conformance-test-support";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";

describePersistenceConformance({
  backend: "native SQLite",
  createDatabase: createSqliteTestDatabase,
});
