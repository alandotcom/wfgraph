import { afterEach, describe, expect, it } from "vitest";
import {
  type DatabaseRuntimeConfig,
  normalizeDatabaseConfig,
} from "#src/backend/lib/db/config";
import {
  createDatabaseSurface,
  createMigrationClient,
  type DatabaseSurface,
} from "#src/backend/lib/db/index";

const URL_CONFIG = {
  url: "postgresql://rova:rova@127.0.0.1:5439/rova_config_test",
} as const;

const DISCRETE_CONFIG = {
  host: "db.internal",
  port: 6432,
  user: "rova",
  password: "rova",
  database: "rova_config_test",
} as const;

// Each surface owns a lazy postgres.js pool. Close every one even though these
// tests inspect only its options, so a later test cannot inherit a live client.
const opened: DatabaseSurface[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(async (surface) => surface.close()));
});

/** The pair every entry point makes: check the host's words, then open a pool. */
function open(config: DatabaseRuntimeConfig): DatabaseSurface {
  const surface = createDatabaseSurface(normalizeDatabaseConfig(config));
  opened.push(surface);
  return surface;
}

function migrationClientFor(config: DatabaseRuntimeConfig) {
  return createMigrationClient(normalizeDatabaseConfig(config));
}

describe("the pools an app opens", () => {
  it("size the query pool from the config", () => {
    expect(open({ ...URL_CONFIG, maxConnections: 4 }).client.options.max).toBe(
      4
    );
  });

  it("hand the discrete fields to postgres.js as fields", () => {
    const { options } = migrationClientFor(DISCRETE_CONFIG);

    expect(options.host).toEqual(["db.internal"]);
    expect(options.port).toEqual([6432]);
    expect(options.user).toBe("rova");
    expect(options.database).toBe("rova_config_test");
  });

  // Not the host's business: the advisory lock runMigrations takes is
  // session-scoped, so the migrator's pool stays at the one connection that puts
  // the lock and the statements it guards on the same session.
  it("keep the migration pool at one connection whatever the host asked for", () => {
    expect(
      migrationClientFor({ ...URL_CONFIG, maxConnections: 8 }).options.max
    ).toBe(1);
  });

  it("carry a database name a URL would have to escape", () => {
    expect(
      open({ ...DISCRETE_CONFIG, database: "rova test" }).client.options
        .database
    ).toBe("rova test");
  });

  it("leave the port to Postgres when the host does not say", () => {
    const { options } = migrationClientFor({
      host: "db.internal",
      user: "rova",
      database: "rova_config_test",
    });

    expect(options.port).toEqual([5432]);
  });

  it("put the configured schema on every connection", () => {
    const surface = open({ ...URL_CONFIG, schema: "tenant_alpha" });

    expect(surface.schema).toBe("tenant_alpha");
    expect(surface.client.options.connection.search_path).toBe("tenant_alpha");
    expect(
      migrationClientFor({ ...URL_CONFIG, schema: "tenant_alpha" }).options
        .connection.search_path
    ).toBe("tenant_alpha");
  });
});

describe("opening a second surface", () => {
  it("keeps each app's database handle on its own surface", () => {
    const first = open(URL_CONFIG);
    const second = open({ ...DISCRETE_CONFIG, database: "elsewhere" });

    expect(first.client).not.toBe(second.client);
    expect(first.client.options.database).toBe("rova_config_test");
    expect(second.client.options.database).toBe("elsewhere");
  });

  it("closing one surface does not close another", async () => {
    const first = open(URL_CONFIG);
    const second = open({ ...URL_CONFIG, schema: "tenant_alpha" });

    await first.close();

    expect(second.client.options.connection.search_path).toBe("tenant_alpha");
  });
});
