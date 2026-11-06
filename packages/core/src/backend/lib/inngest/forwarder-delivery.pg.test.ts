/** The Inngest forwarder's delivery cases, run against PostgreSQL. */

import { describeForwarderDeliveryCases } from "#src/backend/lib/inngest/forwarder-delivery-cases";
import {
  postgresTestUrl,
  POSTGRES_TEST_URL_VARIABLE,
  sharedPostgresTestDatabase,
} from "#src/backend/persistence/postgres-test-database";

const shared = sharedPostgresTestDatabase();

describeForwarderDeliveryCases({
  backend: "PostgreSQL",
  createDatabase: shared.createDatabase,
  teardown: shared.teardown,
  skip: postgresTestUrl()
    ? undefined
    : `set ${POSTGRES_TEST_URL_VARIABLE} to run them: docker compose up -d`,
});
