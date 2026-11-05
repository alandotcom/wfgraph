/** The database execution driver's cases, run against PostgreSQL. */

import { describeExecutionDriverCases } from "#src/backend/services/executions/testing/driver-cases";
import {
  postgresTestUrl,
  POSTGRES_TEST_URL_VARIABLE,
  sharedPostgresTestDatabase,
} from "#src/backend/persistence/postgres-test-database";

const shared = sharedPostgresTestDatabase();

describeExecutionDriverCases({
  backend: "PostgreSQL",
  createDatabase: shared.createDatabase,
  teardown: shared.teardown,
  crossProcess: true,
  skip: postgresTestUrl()
    ? undefined
    : `set ${POSTGRES_TEST_URL_VARIABLE} to run them: docker compose up -d`,
});
