import { uniq } from "es-toolkit/array";
import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "#src/backend/lib/db/schema";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import { WORKFLOW_SCOPED_AUDIT_EVENT_TYPES } from "@wfgraph/shared/lifecycle/audit-event-types";
import { INTEGRATION_REFRESH_STATES } from "@wfgraph/shared/types/integration";

/**
 * The committed SQL, held to naming no schema.
 *
 * `database.schema` works by declaring the tables unqualified and letting the
 * connection's search_path place them, so a schema name reaching the generated
 * SQL would pin the tables to one schema for every host at once. drizzle-kit
 * writes exactly one such qualifier today, `REFERENCES "public"."workflows"`, and
 * `scripts/unqualify-migrations.ts` takes that spelling off during
 * `pnpm run db:generate`. This is the guard that does not have to know the
 * spelling: any qualifier that is not one of Workflow Graph's own table names fails here.
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
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  return await Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"),
    }))
  );
}

describe("the generated migrations", () => {
  it("are there to be checked", async () => {
    expect((await readMigrations()).length).toBeGreaterThan(0);
  });

  it("qualify nothing but Workflow Graph's own tables", async () => {
    const foreign = (await readMigrations()).flatMap((migration) =>
      [...migration.sql.matchAll(QUALIFIER)]
        .map(([, identifier]) => identifier)
        .filter((identifier) => !tableNames.has(identifier ?? ""))
        .map((identifier) => `${migration.name}: "${identifier}"`)
    );

    expect(uniq(foreign)).toEqual([]);
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
      `CREATE INDEX "workflow_executions_in_flight_by_entity_idx"`
    );
    expect(sql).toContain(`in (${predicate})`);
  });

  // Same guard, for the index the Refused Starts list reads. Without this pin,
  // a literal renamed in WORKFLOW_SCOPED_AUDIT_EVENT_TYPES with no regenerated
  // migration goes unnoticed here and falls back to a full audit-history scan
  // at read time.
  it("index the workflow-scoped audit rows the refusals list reads", async () => {
    const sql = (await readMigrations())
      .map((migration) => migration.sql)
      .join("\n");
    const predicate = WORKFLOW_SCOPED_AUDIT_EVENT_TYPES.map(
      (type) => `'${type}'`
    ).join(", ");

    expect(sql).toContain(
      `CREATE INDEX "workflow_execution_events_workflow_scoped_idx"`
    );
    expect(sql).toContain(`in (${predicate})`);
  });
  // The version sweep at publish is the first thing that deletes a
  // workflow_versions row, and published_version_id is `on delete set null`, so
  // Postgres runs that action for every version deleted whether a referrer
  // exists or not. Without this index it scans the whole workflows table each
  // time, and the sweep also asks the same question in its own predicate.
  it("index the published_version_id a workflow_versions delete sets null", async () => {
    const sql = (await readMigrations())
      .map((migration) => migration.sql)
      .join("\n");

    expect(sql).toContain(`CREATE INDEX "workflows_published_version_id_idx"`);
  });

  it("constrain integration refresh states to the lifecycle vocabulary", async () => {
    const sql = (await readMigrations())
      .map((migration) => migration.sql)
      .join("\n");
    const predicate = INTEGRATION_REFRESH_STATES.map(
      (status) => `'${status}'`
    ).join(", ");

    expect(sql).toContain(
      `ADD CONSTRAINT "integrations_refresh_state_check" CHECK ("refresh_state" in (${predicate}))`
    );
  });

  // Drizzle matches applied migrations by folder name after the v1 journal
  // upgrade, and compares hashes only while backfilling that name. This entry
  // is what every existing database recorded after the squash; changing the
  // SQL (and therefore the hash) is a deliberate act that costs every operator
  // a dropped schema, and `assertJournalHashesAreOurs` is what turns it into a
  // sentence.
  it("keeps the journal's baseline entries append-only", () => {
    const migrations = readMigrationFiles({
      migrationsFolder: MIGRATIONS_DIR,
    });

    expect(
      migrations
        .slice(0, 1)
        .map((migration) => [migration.name, migration.hash])
    ).toEqual([
      [
        "20260806044337_peaceful_blacklash",
        "480ea8e2d4266c78673f79bef971a48a90ca6414470ea8002cc88b08b9443114",
      ],
    ]);
  });
});
