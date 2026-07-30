import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DatabaseRuntimeConfig,
  normalizeDatabaseConfig,
} from "#src/backend/lib/db/config";
import {
  closeDatabaseRuntime,
  configureDatabaseRuntime,
  getDatabaseSchema,
  getMigrationClient,
  getQueryClient,
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

/** The pair every entry point makes: check the host's words, then record them. */
function configure(config: DatabaseRuntimeConfig): void {
  configureDatabaseRuntime(normalizeDatabaseConfig(config));
}

// The runtime state is process-global and vitest shares a worker between files,
// so a config left behind is the one the next file's configure call refuses to
// rebind.
beforeEach(closeDatabaseRuntime);
afterEach(closeDatabaseRuntime);

describe("the pools the runtime opens", () => {
  it("size the query pool from the config", () => {
    configure({ ...URL_CONFIG, maxConnections: 4 });

    expect(getQueryClient().options.max).toBe(4);
  });

  it("hand the discrete fields to postgres.js as fields", () => {
    configure(DISCRETE_CONFIG);

    const options = getMigrationClient().options;

    expect(options.host).toEqual(["db.internal"]);
    expect(options.port).toEqual([6432]);
    expect(options.user).toBe("rova");
    expect(options.database).toBe("rova_config_test");
    // One connection, and not the host's business: the migrator runs its
    // statements in order and holds its lock on that one session.
    expect(options.max).toBe(1);
  });

  it("carry a database name a URL would have to escape", () => {
    configure({ ...DISCRETE_CONFIG, database: "rova test" });

    expect(getQueryClient().options.database).toBe("rova test");
  });

  it("leave the port to Postgres when the host does not say", () => {
    configure({
      host: "db.internal",
      user: "rova",
      database: "rova_config_test",
    });

    expect(getMigrationClient().options.port).toEqual([5432]);
  });

  it("put the configured schema on every connection", () => {
    configure({ ...URL_CONFIG, schema: "tenant_alpha" });

    expect(getDatabaseSchema()).toBe("tenant_alpha");
    expect(getQueryClient().options.connection.search_path).toBe(
      "tenant_alpha"
    );
    expect(getMigrationClient().options.connection.search_path).toBe(
      "tenant_alpha"
    );
  });
});

// Every entry point configures before it connects, so an unset config means a
// caller reached a pool from outside one. Guessing from the environment instead
// is how a process ends up querying a database nobody named.
describe("reaching a connection before anything configured one", () => {
  it("refuses to name a schema", () => {
    expect(() => getDatabaseSchema()).toThrow(
      "The database runtime has not been configured"
    );
  });

  it("refuses to open a pool", () => {
    expect(() => getQueryClient()).toThrow(
      "The database runtime has not been configured"
    );
  });
});

describe("configuring the runtime twice", () => {
  it("accepts the same configuration again", () => {
    configure(URL_CONFIG);

    expect(() => configure(URL_CONFIG)).not.toThrow();
  });

  it("accepts the same discrete configuration again", () => {
    configure(DISCRETE_CONFIG);

    expect(() => configure({ ...DISCRETE_CONFIG })).not.toThrow();
  });

  it("refuses a second database, whichever arm names it", () => {
    configure(URL_CONFIG);

    expect(() =>
      configure({ ...DISCRETE_CONFIG, database: "elsewhere" })
    ).toThrow("already configured with a different configuration");
  });

  // The schema is part of what identifies the database a service will query, so
  // the same server under a second schema is a second database as far as the
  // guard is concerned.
  it("refuses a second schema on the same server", () => {
    configure(URL_CONFIG);

    expect(() => configure({ ...URL_CONFIG, schema: "tenant_alpha" })).toThrow(
      "already configured with a different configuration"
    );
  });

  it("refuses a different configuration once a pool is open", () => {
    configure(URL_CONFIG);
    getQueryClient();

    expect(() => configure({ ...URL_CONFIG, maxConnections: 4 })).toThrow(
      "already configured with a different configuration"
    );
  });
});
