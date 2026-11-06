/** The Inngest forwarder's delivery cases, run against native SQLite. */

import { describeForwarderDeliveryCases } from "#src/backend/lib/inngest/forwarder-delivery-cases";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";

describeForwarderDeliveryCases({
  backend: "native SQLite",
  createDatabase: createSqliteTestDatabase,
});
