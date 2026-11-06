/**
 * The `createWfGraphApp` options the app's test files start from. Opening an
 * app opens no connection to this database: the client is lazy and migrations
 * run only when asked, so a case that serves routes from process memory needs
 * no Postgres, and a case that runs anything names a database of its own.
 */

import { trustWfGraphUpstream } from "#src/index";
import { wfPostgres } from "#src/backend/persistence/postgres";

export const BASE_OPTIONS = {
  auth: trustWfGraphUpstream(),
  persistence: wfPostgres({
    url: "postgresql://wfgraph:wfgraph@127.0.0.1:1/wfgraph_test",
  }),
  encryption: { key: "a".repeat(64) },
} as const;
