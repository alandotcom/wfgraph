/** The shared repository contract, answered by a live PostgreSQL. */

import {
  createPostgresTestDatabase,
  POSTGRES_TEST_URL_VARIABLE,
  postgresTestUrl,
} from "#src/backend/persistence/postgres-test-database";
import { describePersistenceConformance } from "#src/backend/persistence/persistence-conformance-test-support";

describePersistenceConformance({
  backend: "PostgreSQL",
  createDatabase: createPostgresTestDatabase,
  skip: postgresTestUrl()
    ? undefined
    : `set ${POSTGRES_TEST_URL_VARIABLE} to run it: docker compose up -d`,
});
