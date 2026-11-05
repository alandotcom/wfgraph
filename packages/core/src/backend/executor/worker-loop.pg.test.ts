/** The database executor's worker loop cases, run against PostgreSQL. */

import { describeWorkerLoopCases } from "#src/backend/executor/testing/worker-loop-cases";
import {
  postgresTestUrl,
  POSTGRES_TEST_URL_VARIABLE,
  sharedPostgresTestDatabase,
} from "#src/backend/persistence/postgres-test-database";

const shared = sharedPostgresTestDatabase();

describeWorkerLoopCases({
  backend: "PostgreSQL",
  createDatabase: shared.createDatabase,
  teardown: shared.teardown,
  skip: postgresTestUrl()
    ? undefined
    : `set ${POSTGRES_TEST_URL_VARIABLE} to run them: docker compose up -d`,
});
