/** The database executor's pass cases, run against PostgreSQL. */

import { describePassCases } from "#src/backend/executor/testing/pass-cases";
import {
  postgresTestUrl,
  POSTGRES_TEST_URL_VARIABLE,
  sharedPostgresTestDatabase,
} from "#src/backend/persistence/postgres-test-database";

const shared = sharedPostgresTestDatabase();

describePassCases({
  backend: "PostgreSQL",
  createDatabase: shared.createDatabase,
  teardown: shared.teardown,
  skip: postgresTestUrl()
    ? undefined
    : `set ${POSTGRES_TEST_URL_VARIABLE} to run them: docker compose up -d`,
});
