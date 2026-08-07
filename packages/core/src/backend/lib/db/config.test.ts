import { describe, expect, it } from "vitest";
import {
  type DatabaseRuntimeConfig,
  normalizeDatabaseConfig,
} from "#src/backend/lib/db/config";

const URL_CONFIG = {
  url: "postgresql://wfgraph:wfgraph@127.0.0.1:5439/wfgraph_config_test",
} as const;

const DISCRETE_CONFIG = {
  host: "db.internal",
  port: 6432,
  user: "wfgraph",
  password: "wfgraph",
  database: "wfgraph_config_test",
} as const;

describe("the database connection options", () => {
  it("take one URL", () => {
    expect(
      normalizeDatabaseConfig({ ...URL_CONFIG, maxConnections: 4 })
    ).toEqual({
      url: URL_CONFIG.url,
      schema: "_workflows",
      maxConnections: 4,
      ssl: undefined,
    });
  });

  // The fields survive as fields. Folding them into a URL first would hand this
  // database name over as "wfgraph%20test", since postgres.js decodes a URL's user
  // and password but not its path segment.
  it("take the discrete fields a platform hands out separately", () => {
    expect(
      normalizeDatabaseConfig({ ...DISCRETE_CONFIG, database: "wfgraph test" })
    ).toMatchObject({
      host: "db.internal",
      port: 6432,
      user: "wfgraph",
      database: "wfgraph test",
    });
  });

  it("leave the port to Postgres when the host does not say", () => {
    const config = normalizeDatabaseConfig({
      host: "db.internal",
      user: "wfgraph",
      database: "wfgraph_config_test",
    });

    expect(config.port).toBeUndefined();
  });

  it("default the query pool to ten connections", () => {
    expect(normalizeDatabaseConfig(URL_CONFIG).maxConnections).toBe(10);
  });

  it("refuse a config that names no database", () => {
    expect(() =>
      normalizeDatabaseConfig({ host: "db.internal" } as DatabaseRuntimeConfig)
    ).toThrow("either database.url, or all of database.host");
  });

  it("refuse an empty url", () => {
    expect(() => normalizeDatabaseConfig({ url: "   " })).toThrow(
      "either database.url"
    );
  });

  // Both spellings at once is the one case where Workflow Graph would have to choose, and
  // whichever it chose would surprise somebody. The union's `never` fields refuse
  // this literal outright, so only a host who is not on TypeScript can get here,
  // and the cast is what stands in for one.
  it("refuse a url and discrete fields together", () => {
    const mixed = { ...URL_CONFIG, host: "db.internal" };

    expect(() =>
      normalizeDatabaseConfig(mixed as unknown as DatabaseRuntimeConfig)
    ).toThrow("not both");
  });

  it("refuse a host holding anything but a host", () => {
    for (const host of ["db.internal:6432", "db.internal/wfgraph", "a b"]) {
      expect(() =>
        normalizeDatabaseConfig({ ...DISCRETE_CONFIG, host })
      ).toThrow("database.host takes a host name or address on its own");
    }
  });

  it("refuse a port that is not one", () => {
    for (const port of [0, -1, 70_000, 5432.5]) {
      expect(() =>
        normalizeDatabaseConfig({ ...DISCRETE_CONFIG, port })
      ).toThrow("database.port must be a whole number");
    }
  });

  // postgres.js would let the URL's copy win, leaving the migrator creating one
  // schema while every query read another. The percent-encoded spelling is here
  // because the parameters are read parsed: a substring test misses it.
  it("refuse a url that names a search_path of its own", () => {
    for (const url of [
      "postgresql://wfgraph@127.0.0.1:5439/wfgraph?search_path=tenant_alpha",
      "postgresql://wfgraph@127.0.0.1:5439/wfgraph?search%5Fpath=tenant_alpha",
      "postgresql://wfgraph@127.0.0.1:5439/wfgraph?options=-c%20search_path%3Dtenant_alpha",
    ]) {
      expect(() => normalizeDatabaseConfig({ url })).toThrow(
        "may not carry a search_path"
      );
    }
  });

  // A password is not a query parameter, so nothing in it is a search_path.
  it("accept a password that happens to read like one", () => {
    expect(() =>
      normalizeDatabaseConfig({
        url: "postgresql://wfgraph:search_path%3Dx@127.0.0.1:5439/wfgraph",
      })
    ).not.toThrow();
  });
});

describe("the database schema option", () => {
  it("names _workflows unless the host says otherwise", () => {
    expect(normalizeDatabaseConfig(URL_CONFIG).schema).toBe("_workflows");
  });

  it("takes the host's own schema", () => {
    expect(
      normalizeDatabaseConfig({ ...URL_CONFIG, schema: "tenant_alpha" }).schema
    ).toBe("tenant_alpha");
  });

  // An unquoted identifier folds to lowercase in a search_path, so a mixed-case
  // name would address a different schema than the one written.
  it("refuses a name Postgres would not read back as written", () => {
    for (const schema of [
      "Tenant",
      "tenant-alpha",
      "1tenant",
      "tenant alpha",
    ]) {
      expect(() => normalizeDatabaseConfig({ ...URL_CONFIG, schema })).toThrow(
        "must be an unquoted lowercase Postgres identifier"
      );
    }
  });

  it("refuses a name past the length Postgres truncates at", () => {
    expect(() =>
      normalizeDatabaseConfig({ ...URL_CONFIG, schema: "s".repeat(64) })
    ).toThrow("at most 63 characters");
  });
});
