import { describe, expect, it } from "vitest";
import {
  wfHyperdrive,
  hyperdrivePostgresClientOptions,
} from "#src/backend/persistence/hyperdrive-postgres";

describe("Hyperdrive PostgreSQL persistence", () => {
  it("does not rely on connection-scoped search_path state", () => {
    const options = hyperdrivePostgresClientOptions();

    expect(options.connection).toEqual({
      application_name: "wfgraph-hyperdrive",
    });
    expect(options.connection).not.toHaveProperty("search_path");
  });

  it("requires no pretend cache configuration", () => {
    expect(() =>
      wfHyperdrive({
        connectionString: "postgresql://example.invalid/wfgraph",
      })
    ).not.toThrow();
  });
});
