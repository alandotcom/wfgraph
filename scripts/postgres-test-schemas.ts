// This import runs first, so `WFGRAPH_TEST_DATABASE_URL` is in place before the
// sweep reads it.
// vitest runs `globalSetup` in the main process before any worker starts, so
// the `setupFiles` copy of this file never reaches here.
import "../load-env";

export { setup } from "@wfgraph/core/backend/persistence/postgres-test-global-setup";
