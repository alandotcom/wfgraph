import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "#src/backend/lib/db/schema";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@rova/shared/lifecycle/execution-contracts";

/**
 * The committed SQL, held to naming no schema.
 *
 * `database.schema` works by declaring the tables unqualified and letting the
 * connection's search_path place them, so a schema name reaching the generated
 * SQL would pin the tables to one schema for every host at once. drizzle-kit
 * writes exactly one such qualifier today, `REFERENCES "public"."workflows"`, and
 * `scripts/unqualify-migrations.ts` takes that spelling off during
 * `pnpm run db:generate`. This is the guard that does not have to know the
 * spelling: any qualifier that is not one of Rova's own table names fails here.
 */
const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../drizzle"
);

const tableNames = new Set(
  Object.values<unknown>(schema)
    .filter((exported: unknown): exported is PgTable => is(exported, PgTable))
    .map((table) => getTableConfig(table).name)
);

// A qualified name in Postgres DDL as drizzle-kit writes it: the quoted
// identifier ahead of a dot. A table's own name shows up this way in the partial
// index predicate, which is why the assertion is about which names appear rather
// than whether any do.
const QUALIFIER = /"([^"]+)"\./g;

async function readMigrations(): Promise<{ name: string; sql: string }[]> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((name) =>
    name.endsWith(".sql")
  );

  return await Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(join(MIGRATIONS_DIR, name), "utf8"),
    }))
  );
}

describe("the generated migrations", () => {
  it("are there to be checked", async () => {
    expect((await readMigrations()).length).toBeGreaterThan(0);
  });

  it("qualify nothing but Rova's own tables", async () => {
    const foreign = (await readMigrations()).flatMap((migration) =>
      [...migration.sql.matchAll(QUALIFIER)]
        .map(([, identifier]) => identifier)
        .filter((identifier) => !tableNames.has(identifier ?? ""))
        .map((identifier) => `${migration.name}: "${identifier}"`)
    );

    expect([...new Set(foreign)]).toEqual([]);
  });

  // The predicate is generated from IN_FLIGHT_EXECUTION_STATUSES, so this is
  // where a status added to that list without a regenerated migration shows up:
  // the index would stop covering the query its guard makes.
  it("index the in-flight rows the concurrency query reads", async () => {
    const sql = (await readMigrations())
      .map((migration) => migration.sql)
      .join("\n");
    const predicate = IN_FLIGHT_EXECUTION_STATUSES.map(
      (status) => `'${status}'`
    ).join(", ");

    expect(sql).toContain(
      `CREATE INDEX "workflow_executions_in_flight_by_correlation_idx"`
    );
    expect(sql).toContain(`in (${predicate})`);
  });
  // Drizzle applies a migration by comparing folder timestamps and never hashes,
  // so a regenerated baseline re-runs `CREATE TABLE` on every database that ran
  // the old one. These two entries are what every existing database recorded;
  // changing them is a deliberate act that costs every operator a dropped schema,
  // and `assertJournalHashesAreOurs` is what turns it into a sentence.
  it("keeps the journal's baseline entries append-only", async () => {
    const journal = JSON.parse(
      await readFile(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")
    );

    expect(
      journal.entries
        .slice(0, 2)
        .map((entry: { tag: string; when: number }) => [entry.tag, entry.when])
    ).toEqual([
      ["0000_new_lord_tyger", 1785420141549],
      ["0001_typical_zaladane", 1785438823846],
    ]);
  });
});
