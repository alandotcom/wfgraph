/**
 * The shared repository contract, answered by native SQLite.
 *
 * A database is one file in a temp directory, and dropping it is removing that
 * directory. Cases that reach into SQLite's own storage live in sqlite.test.ts
 * and sqlite.integrations.test.ts beside this.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import {
  conformanceCipher,
  connect,
  describePersistenceConformance,
} from "#src/backend/persistence/persistence-conformance-test-support";

describePersistenceConformance({
  backend: "native SQLite",
  createDatabase: async () => {
    const directory = await mkdtemp(join(tmpdir(), "wfgraph-sqlite-"));
    const filename = join(directory, "wfgraph.db");

    return {
      open: async (options) =>
        connect(
          await wfSqlite({ filename }).open(
            options?.cipher ?? conformanceCipher
          )
        ),
      drop: () => rm(directory, { recursive: true, force: true }),
    };
  },
});
