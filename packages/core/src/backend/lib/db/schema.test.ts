import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "#src/backend/lib/db/schema";

// Read off the module rather than listed by hand, so a table added tomorrow is
// held to the rule below without anyone remembering to add it here.
const declaredTables = Object.values<unknown>(schema).filter(
  (exported: unknown): exported is PgTable => is(exported, PgTable)
);

describe("the schema declarations", () => {
  it("declare tables at all", () => {
    expect(declaredTables.length).toBeGreaterThan(0);
  });

  // The whole of `database.schema` rests on this: an unqualified table is
  // resolved through the connection's search_path, and one table that names a
  // schema would go on living in that schema whatever the host configured.
  it("name no schema, so search_path decides where the tables live", () => {
    const qualified = declaredTables
      .map((table) => getTableConfig(table))
      .filter((table) => table.schema !== undefined)
      .map((table) => table.name);

    expect(qualified).toEqual([]);
  });
});
