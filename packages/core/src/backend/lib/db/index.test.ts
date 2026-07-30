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

// The claim on the database is process-wide and vitest shares a worker between
// files, so a surface left open is what the next file's first surface is refused
// by.
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

// One Rova per process (ADR-0002): a second surface would open a pool beside the
// first one's, and the two would then sit under one claim.
describe("opening a second surface", () => {
  it("refuses one, whatever it names", () => {
    open(URL_CONFIG);

    expect(() => open(URL_CONFIG)).toThrow("already open in this process");
    expect(() => open({ ...DISCRETE_CONFIG, database: "elsewhere" })).toThrow(
      "already open in this process"
    );
  });

  it("takes the claim back when the first surface closes", async () => {
    await open(URL_CONFIG).close();

    expect(() => open({ ...URL_CONFIG, schema: "tenant_alpha" })).not.toThrow();
  });

  // A host that disposes an app twice: the second close has no claim of its own
  // left to give back, and taking the live one would let a third surface in.
  it("leaves the live claim alone when a closed surface closes again", async () => {
    const first = open(URL_CONFIG);
    await first.close();
    open(URL_CONFIG);

    await first.close();

    expect(() => open(URL_CONFIG)).toThrow("already open in this process");
  });

  // postgres.js checks its options in the constructor, and an unsupported
  // target_session_attrs is one it refuses there. Nothing was returned, so
  // nothing could release a claim taken before that throw.
  it("takes no claim when the pool cannot be built", () => {
    expect(() =>
      open({ url: `${URL_CONFIG.url}?target_session_attrs=bogus` })
    ).toThrow("target_session_attrs");

    expect(() => open(URL_CONFIG)).not.toThrow();
  });
});
