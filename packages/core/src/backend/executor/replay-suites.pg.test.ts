/** The replay suites' database-executor drives, run through PostgreSQL. */

import { describeReplaySuites } from "#src/backend/executor/testing/replay-suites";
import {
  postgresTestUrl,
  POSTGRES_TEST_URL_VARIABLE,
  sharedPostgresTestDatabase,
} from "#src/backend/persistence/postgres-test-database";

const shared = sharedPostgresTestDatabase();

describeReplaySuites({
  backend: "PostgreSQL",
  createDatabase: shared.createDatabase,
  teardown: shared.teardown,
  skip: postgresTestUrl()
    ? undefined
    : `set ${POSTGRES_TEST_URL_VARIABLE} to run them: docker compose up -d`,
});
