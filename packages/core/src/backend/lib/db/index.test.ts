import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureDatabaseRuntime,
  type DatabaseRuntimeConfig,
  getDatabaseSchema,
  getMigrationClient,
  getQueryClient,
  resetDatabaseRuntime,
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

// The runtime state is process-global and vitest shares a worker between files,
// so a config left behind is the one the next file's configure call refuses to
// rebind.
beforeEach(resetDatabaseRuntime);
afterEach(async () => {
  vi.unstubAllEnvs();
  await resetDatabaseRuntime();
});

describe("the database connection options", () => {
  it("take one URL", () => {
    configureDatabaseRuntime({ ...URL_CONFIG, maxConnections: 4 });

    expect(getQueryClient().options.max).toBe(4);
  });

  it("take the discrete fields a platform hands out separately", () => {
    configureDatabaseRuntime(DISCRETE_CONFIG);

    const options = getMigrationClient().options;

    expect(options.host).toEqual(["db.internal"]);
    expect(options.port).toEqual([6432]);
    expect(options.user).toBe("rova");
    expect(options.database).toBe("rova_config_test");
    // One connection, and not the host's business: the migrator runs its
    // statements in order and holds its lock on that one session.
    expect(options.max).toBe(1);
  });

  // The fields reach postgres.js as fields. Folding them into a URL first would
  // hand this database name over as "rova%20test", since postgres.js decodes a
  // URL's user and password but not its path segment.
  it("carry a database name a URL would have to escape", () => {
    configureDatabaseRuntime({ ...DISCRETE_CONFIG, database: "rova test" });

    expect(getQueryClient().options.database).toBe("rova test");
  });

  it("leave the port to Postgres when the host does not say", () => {
    configureDatabaseRuntime({
      host: "db.internal",
      user: "rova",
      database: "rova_config_test",
    });

    expect(getMigrationClient().options.port).toEqual([5432]);
  });

  it("refuse a config that names no database", () => {
    expect(() =>
      configureDatabaseRuntime({ host: "db.internal" } as DatabaseRuntimeConfig)
    ).toThrow("either database.url, or all of database.host");
  });

  it("refuse an empty url", () => {
    expect(() => configureDatabaseRuntime({ url: "   " })).toThrow(
      "either database.url"
    );
  });

  // Both spellings at once is the one case where Rova would have to choose, and
  // whichever it chose would surprise somebody. The union's `never` fields refuse
  // this literal outright, so only a host who is not on TypeScript can get here,
  // and the cast is what stands in for one.
  it("refuse a url and discrete fields together", () => {
    const mixed = { ...URL_CONFIG, host: "db.internal" };

    expect(() =>
      configureDatabaseRuntime(mixed as unknown as DatabaseRuntimeConfig)
    ).toThrow("not both");
  });

  it("refuse a host holding anything but a host", () => {
    for (const host of ["db.internal:6432", "db.internal/rova", "a b"]) {
      expect(() =>
        configureDatabaseRuntime({ ...DISCRETE_CONFIG, host })
      ).toThrow("database.host takes a host name or address on its own");
    }
  });

  it("refuse a port that is not one", () => {
    for (const port of [0, -1, 70_000, 5432.5]) {
      expect(() =>
        configureDatabaseRuntime({ ...DISCRETE_CONFIG, port })
      ).toThrow("database.port must be a whole number");
    }
  });

  // postgres.js would let the URL's copy win, leaving the migrator creating one
  // schema while every query read another. The percent-encoded spelling is here
  // because the parameters are read parsed: a substring test misses it.
  it("refuse a url that names a search_path of its own", () => {
    for (const url of [
      "postgresql://rova@127.0.0.1:5439/rova?search_path=tenant_alpha",
      "postgresql://rova@127.0.0.1:5439/rova?search%5Fpath=tenant_alpha",
      "postgresql://rova@127.0.0.1:5439/rova?options=-c%20search_path%3Dtenant_alpha",
    ]) {
      expect(() => configureDatabaseRuntime({ url })).toThrow(
        "may not carry a search_path"
      );
    }
  });

  // A password is not a query parameter, so nothing in it is a search_path.
  it("accept a password that happens to read like one", () => {
    expect(() =>
      configureDatabaseRuntime({
        url: "postgresql://rova:search_path%3Dx@127.0.0.1:5439/rova",
      })
    ).not.toThrow();
  });
});

describe("the database schema option", () => {
  it("puts _workflows on every connection unless the host says otherwise", () => {
    configureDatabaseRuntime(URL_CONFIG);

    expect(getDatabaseSchema()).toBe("_workflows");
    expect(getQueryClient().options.connection.search_path).toBe("_workflows");
  });

  // Both clients, because the migration client is the one that creates the
  // schema and writes the journal. A search_path on only one of them would
  // migrate one schema and query another.
  it("reaches the migration client too", () => {
    configureDatabaseRuntime({ ...URL_CONFIG, schema: "tenant_alpha" });

    expect(getMigrationClient().options.connection.search_path).toBe(
      "tenant_alpha"
    );
    expect(getDatabaseSchema()).toBe("tenant_alpha");
  });

  // An unquoted identifier folds to lowercase in search_path, so "Tenant" would
  // silently mean "tenant". Refusing it is the only way the option means what it
  // says.
  it("refuses a name Postgres would not read back the same way", () => {
    for (const schema of ["Tenant", "with space", "1st", "drop;table", ""]) {
      expect(() => configureDatabaseRuntime({ ...URL_CONFIG, schema })).toThrow(
        "database.schema must be an unquoted lowercase Postgres identifier"
      );
    }
  });

  it("refuses a name past the length Postgres keeps", () => {
    expect(() =>
      configureDatabaseRuntime({ ...URL_CONFIG, schema: "s".repeat(64) })
    ).toThrow("at most 63 characters");
  });
});

// The standalone migration script reaches a client without configuring anything,
// so the environment is a config source like any other and goes through the same
// checks.
describe("the environment, when nothing configured the runtime", () => {
  it("names the schema through DATABASE_SCHEMA", () => {
    vi.stubEnv("DATABASE_SCHEMA", "tenant_beta");

    expect(getDatabaseSchema()).toBe("tenant_beta");
    expect(getMigrationClient().options.connection.search_path).toBe(
      "tenant_beta"
    );
  });

  it("is held to the same identifier rule", () => {
    vi.stubEnv("DATABASE_SCHEMA", "Tenant");

    expect(() => getDatabaseSchema()).toThrow(
      "database.schema must be an unquoted lowercase Postgres identifier"
    );
  });

  it("is held to the same search_path rule", () => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://rova@127.0.0.1:5439/rova?search_path=tenant_alpha"
    );

    expect(() => getDatabaseSchema()).toThrow("may not carry a search_path");
  });
});

describe("configuring the runtime twice", () => {
  it("accepts the same configuration again", () => {
    configureDatabaseRuntime(URL_CONFIG);

    expect(() => configureDatabaseRuntime(URL_CONFIG)).not.toThrow();
  });

  it("accepts the same discrete configuration again", () => {
    configureDatabaseRuntime(DISCRETE_CONFIG);

    expect(() =>
      configureDatabaseRuntime({ ...DISCRETE_CONFIG })
    ).not.toThrow();
  });

  it("refuses a second database, whichever arm names it", () => {
    configureDatabaseRuntime(URL_CONFIG);

    expect(() =>
      configureDatabaseRuntime({ ...DISCRETE_CONFIG, database: "elsewhere" })
    ).toThrow("already configured with a different configuration");
  });

  // The schema is part of what identifies the database a service will query, so
  // the same server under a second schema is a second database as far as the
  // guard is concerned.
  it("refuses a second schema on the same server", () => {
    configureDatabaseRuntime(URL_CONFIG);

    expect(() =>
      configureDatabaseRuntime({ ...URL_CONFIG, schema: "tenant_alpha" })
    ).toThrow("already configured with a different configuration");
  });

  it("refuses a different configuration once a pool is open", () => {
    configureDatabaseRuntime(URL_CONFIG);
    getQueryClient();

    expect(() =>
      configureDatabaseRuntime({ ...URL_CONFIG, maxConnections: 4 })
    ).toThrow("already initialized with a different configuration");
  });
});
