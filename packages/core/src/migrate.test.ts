import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeDatabaseConfig } from "#src/backend/lib/db/config";
import {
  closeDatabaseRuntime,
  configureDatabaseRuntime,
  getDatabaseSchema,
  getQueryClient,
} from "#src/backend/lib/db/index";
import { migrateRovaDatabase } from "#src/migrate";

// A folder that is not there stops the migrator before it opens a connection, so
// a case naming it reaches the configuration step and stops. What the migrator
// does once it has a database is `runMigrations`' own business, with the one
// exception noted below.
const NO_MIGRATIONS = "no-such-folder";
const CONFIG = {
  url: "postgresql://rova:rova@127.0.0.1:5439/rova_migrate_test",
  migrationsDir: NO_MIGRATIONS,
} as const;

beforeEach(closeDatabaseRuntime);
afterEach(closeDatabaseRuntime);

describe("migrateRovaDatabase", () => {
  it("configures the database it was handed, then migrates it", async () => {
    await expect(
      migrateRovaDatabase({ ...CONFIG, schema: "tenant_alpha" })
    ).rejects.toThrow("Migrations folder not found");

    // The schema arrived from the options rather than from the environment, which
    // is what makes this entry usable from a CI job that has no Rova app.
    expect(getDatabaseSchema()).toBe("tenant_alpha");
  });

  it("takes the same configuration twice", async () => {
    await expect(migrateRovaDatabase(CONFIG)).rejects.toThrow(
      "Migrations folder not found"
    );

    // Reaching the migrator a second time rather than the rebinding refusal is
    // what says the config was reused.
    await expect(migrateRovaDatabase(CONFIG)).rejects.toThrow(
      "Migrations folder not found"
    );
  });

  // What the README promises an in-process caller, modelled the way it happens:
  // an app configured the runtime and something queried it. The open pool is what
  // makes this take the "already initialized" comparison rather than the
  // recorded-config one.
  it("migrates from a process that already opened a pool", async () => {
    configureDatabaseRuntime(normalizeDatabaseConfig(CONFIG));
    const queryClient = getQueryClient();

    await expect(migrateRovaDatabase(CONFIG)).rejects.toThrow(
      "Migrations folder not found"
    );

    // The app's own pool is left alone: migrating gives back the migration
    // connection and nothing else.
    expect(getQueryClient()).toBe(queryClient);
  });

  // The comparison is field by field, so an in-process caller has to hand over
  // the whole config the app was built with. Leaving out a pool size the app set
  // reads as a different database, which is the refusal the README warns about.
  it("refuses a config differing in anything, pool size included", async () => {
    configureDatabaseRuntime(
      normalizeDatabaseConfig({ ...CONFIG, maxConnections: 4 })
    );

    await expect(migrateRovaDatabase(CONFIG)).rejects.toThrow(
      "already configured with a different configuration"
    );
  });

  it("refuses a second database in the same process", async () => {
    await expect(migrateRovaDatabase(CONFIG)).rejects.toThrow(
      "Migrations folder not found"
    );

    await expect(
      migrateRovaDatabase({
        ...CONFIG,
        url: "postgresql://rova:rova@127.0.0.1:5439/somewhere_else",
      })
    ).rejects.toThrow("already configured with a different configuration");
  });

  // The one case that gets far enough to open a connection: nothing listens on
  // that port, so the migrator's first statement fails after the pool exists.
  // Giving the pool back even then is what lets a failed CI job exit instead of
  // hanging on an idle socket.
  it("gives the migration pool back when migrating fails", async () => {
    await expect(migrateRovaDatabase({ url: CONFIG.url })).rejects.toThrow(
      /ECONNREFUSED/
    );

    expect(globalThis.__rovaDatabaseState?.migrationClient).toBeNull();
  });

  // The entry configures the runtime the same way `createRovaApp` does, so every
  // refusal that guards the schema guards this too.
  it("refuses a url that names a search_path of its own", async () => {
    await expect(
      migrateRovaDatabase({
        ...CONFIG,
        url: "postgresql://rova@127.0.0.1:5439/rova?search_path=tenant_alpha",
      })
    ).rejects.toThrow("may not carry a search_path");
  });
});
