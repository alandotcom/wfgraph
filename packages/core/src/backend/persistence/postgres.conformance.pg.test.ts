/** The shared repository contract, answered by a live PostgreSQL server. */

import {
  POSTGRES_TEST_URL_VARIABLE,
  postgresTestUrl,
  sharedPostgresTestDatabase,
} from "#src/backend/persistence/postgres-test-database";
import { describePersistenceConformance } from "#src/backend/persistence/persistence-conformance-test-support";

const shared = sharedPostgresTestDatabase();

describePersistenceConformance({
  backend: "PostgreSQL",
  createDatabase: shared.createDatabase,
  teardown: shared.teardown,
  skip: postgresTestUrl()
    ? undefined
    : `set ${POSTGRES_TEST_URL_VARIABLE} to run it: docker compose up -d`,
});
