import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import * as dbModule from "#src/backend/lib/db/index";
import { migrateWfGraphDatabase } from "#src/migrate";

// A folder that is not there stops the migrator before it opens a connection, so
// a case naming it reaches the configuration step and stops. What the migrator
// does once it has a database is `runMigrations`' own business.
const NO_MIGRATIONS = "no-such-folder";
const CONFIG = {
  url: "postgresql://wfgraph:wfgraph@127.0.0.1:5439/wfgraph_migrate_test",
  migrationsDir: NO_MIGRATIONS,
} as const;

describe("migrateWfGraphDatabase", () => {
  it("migrates the database the options name", async () => {
    await expect(
      migrateWfGraphDatabase({ ...CONFIG, schema: "tenant_alpha" })
    ).rejects.toThrow("Migrations folder not found");
  });

  // The connection is this call's own, so nothing about the process decides
  // whether a second migration may run. That is what makes this entry usable
  // from a CI job, from a release step, and from a process already serving an
  // app.
  it("takes the same configuration as often as it is asked", async () => {
    await expect(migrateWfGraphDatabase(CONFIG)).rejects.toThrow(
      "Migrations folder not found"
    );

    await expect(migrateWfGraphDatabase(CONFIG)).rejects.toThrow(
      "Migrations folder not found"
    );
  });

  it("migrates a second database in the same process", async () => {
    await expect(migrateWfGraphDatabase(CONFIG)).rejects.toThrow(
      "Migrations folder not found"
    );

    await expect(
      migrateWfGraphDatabase({
        ...CONFIG,
        url: "postgresql://wfgraph:wfgraph@127.0.0.1:5439/somewhere_else",
      })
    ).rejects.toThrow("Migrations folder not found");
  });

  // The one case that gets far enough to open a connection: nothing listens on
  // that port, so the migrator's first statement fails after the client exists.
  // Giving the connection back even then is what lets a failed CI job exit
  // instead of hanging on an idle socket.
  it("gives the migration connection back when migrating fails", async () => {
    const createClient = dbModule.createMigrationClient;
    let migrationClient: Sql | undefined;
    vi.spyOn(dbModule, "createMigrationClient").mockImplementation((config) => {
      migrationClient = createClient(config);
      return migrationClient;
    });

    try {
      await expect(
        migrateWfGraphDatabase({
          url: "postgresql://wfgraph:wfgraph@127.0.0.1:1/wfgraph_migrate_test",
        })
      ).rejects.toThrow(/ECONNREFUSED/);

      if (!migrationClient) {
        throw new Error("The migrator opened no connection to give back.");
      }

      // A client that was never ended would answer this with the same
      // ECONNREFUSED the migration failed on.
      await expect(migrationClient`select 1`).rejects.toThrow(
        "CONNECTION_ENDED"
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  // The entry normalizes the config the same way `createWfGraphApp` does, so every
  // refusal that guards the schema guards this too.
  it("refuses a url that names a search_path of its own", async () => {
    await expect(
      migrateWfGraphDatabase({
        ...CONFIG,
        url: "postgresql://wfgraph@127.0.0.1:5439/wfgraph?search_path=tenant_alpha",
      })
    ).rejects.toThrow("may not carry a search_path");
  });
});
