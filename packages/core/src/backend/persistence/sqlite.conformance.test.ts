/**
 * The shared repository contract is answered by native SQLite. A database is one
 * temp directory. Cases reaching into SQLite's own storage live beside this
 * file.
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
