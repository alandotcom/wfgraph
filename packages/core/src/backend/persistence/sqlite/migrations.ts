import { createHash } from "node:crypto";
import { Data, Effect } from "effect";
import { sql } from "drizzle-orm";
import type { EffectSQLiteNodeDatabase } from "drizzle-orm/effect-sqlite-node";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { sqliteMigrations } from "#src/backend/persistence/sqlite/generated-migrations";

const MIGRATIONS_TABLE = "__wfgraph_sqlite_migrations";
const LEGACY_SCHEMA_FINGERPRINTS = new Map([
  [6, "04c0c74f0205f808a3822afb497e2abf5d007a8a7e0c1e4b9df364ec74bb6267"],
  [7, "a2929e0c5f5e94800e8ab3840f476aee1ce1e11c18638ec5fbfa516c5edf75f8"],
]);
const CURRENT_SCHEMA_FINGERPRINTS = new Set([
  // A database created by all generated migrations.
  "fb423fd36740f96c03728d4bb6517969c67d670808fad5c7966ed523c5210738",
  // An adopted version-6 or version-7 database keeps its original table DDL.
  "ae98ab4ac80090f3a0114c9547f2d1da59c5a27090caca2c87fdb363b13832c9",
]);
const EXPECTED_TABLES = [
  "api_keys",
  "integrations",
  "oauth_authorization_attempts",
  "workflow_event_subscriptions",
  "workflow_execution_events",
  "workflow_execution_logs",
  "workflow_executions",
  "workflow_versions",
  "workflow_wait_states",
  "workflows",
] as const;
const EXPECTED_MIGRATION_COLUMNS = [
  ["id", "INTEGER", 0, 1],
  ["hash", "TEXT", 1, 0],
  ["created_at", "NUMERIC", 0, 0],
  ["name", "TEXT", 0, 0],
  ["applied_at", "TEXT", 0, 0],
] as const;

class SqliteInitializationError extends Data.TaggedError(
  "SqliteInitializationError"
)<{ message: string }> {}

type SqliteMigrationDatabase = Pick<
  EffectSQLiteNodeDatabase,
  "all" | "get" | "run" | "transaction"
>;

type SqliteMigrationExecutor = Pick<
  EffectSQLiteNodeDatabase,
  "all" | "get" | "run"
>;

type MigrationJournalRow = {
  readonly id: number;
  readonly hash: string;
  readonly created_at: number;
  readonly name: string;
};

type ForeignKeyViolation = {
  readonly table: string;
  readonly rowid: number | null;
  readonly parent: string;
  readonly fkid: number;
};

type SchemaInspection = {
  readonly version: number;
  readonly tables: readonly { readonly name: string }[];
  readonly fingerprint: string;
};

const inspectSchema = Effect.fn("inspectSqliteSchema")(function* (
  database: SqliteMigrationExecutor
) {
  const versionRow = yield* database.get<{ user_version: number }>(
    sql`pragma user_version`
  );
  if (typeof versionRow?.user_version !== "number") {
    return yield* new SqliteInitializationError({
      message: "SQLite did not return its schema version",
    });
  }
  const tables = yield* database.all<{ name: string }>(sql`
    select name from sqlite_master
    where type = 'table' and name not like 'sqlite_%'
    order by name
  `);
  const definitions = yield* database.all<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string;
  }>(sql`
    select type, name, tbl_name, sql from sqlite_master
    where tbl_name in (${sql.join(
      EXPECTED_TABLES.map((table) => sql`${table}`),
      sql`, `
    )})
      and sql is not null
    order by type, name
  `);
  const canonical = definitions.map((definition) => [
    definition.type,
    definition.name,
    definition.tbl_name,
    definition.sql.replaceAll(/\s+/g, "").toLowerCase(),
  ]);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  return { version: versionRow.user_version, tables, fingerprint };
});

function migrationsFrom(
  migrations: readonly MigrationMeta[]
): readonly MigrationMeta[] {
  if (migrations.length === 0) {
    throw new SqliteInitializationError({
      message: "Workflow Graph's SQLite baseline migration is missing",
    });
  }
  return migrations;
}

const validateMigrationJournal = Effect.fn("validateSqliteMigrationJournal")(
  function* (
    database: SqliteMigrationDatabase,
    migrations: readonly MigrationMeta[]
  ) {
    const columns = yield* database.all<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>(sql`
      select name, type, "notnull", pk
      from pragma_table_info(${MIGRATIONS_TABLE})
      order by cid
    `);
    const journalShape = columns.map((column) => [
      column.name,
      column.type.toUpperCase(),
      column.notnull,
      column.pk,
    ]);
    if (
      JSON.stringify(journalShape) !==
      JSON.stringify(EXPECTED_MIGRATION_COLUMNS)
    ) {
      return yield* new SqliteInitializationError({
        message:
          "Workflow Graph's SQLite migration journal has an unrecognized schema",
      });
    }

    const journal = yield* database.all<MigrationJournalRow>(sql`
      select id, hash, created_at, name
      from ${sql.identifier(MIGRATIONS_TABLE)}
      order by id
    `);
    if (journal.length === 0) {
      const existingTables = yield* database.all<{ name: string }>(sql`
        select name from sqlite_master
        where type = 'table'
          and name in (${sql.join(
            EXPECTED_TABLES.map((table) => sql`${table}`),
            sql`, `
          )})
      `);
      if (existingTables.length > 0) {
        return yield* new SqliteInitializationError({
          message:
            "Workflow Graph's SQLite migration journal does not contain the shipped baseline",
        });
      }
    }
    for (const [index, applied] of journal.entries()) {
      const local = migrations[index];
      if (local === undefined) {
        return yield* new SqliteInitializationError({
          message:
            "Workflow Graph's SQLite database was migrated by a newer release",
        });
      }
      if (
        applied.hash !== local.hash ||
        applied.created_at !== local.folderMillis ||
        applied.name !== local.name
      ) {
        return yield* new SqliteInitializationError({
          message:
            "Workflow Graph's SQLite migration journal does not match the shipped migrations",
        });
      }
    }
    return migrations.slice(journal.length);
  }
);

function violationKey(violation: ForeignKeyViolation): string {
  return JSON.stringify([
    violation.table,
    violation.rowid,
    violation.parent,
    violation.fkid,
  ]);
}

const adoptLegacySchema = Effect.fn("adoptLegacySqliteSchema")(function* (
  database: SqliteMigrationExecutor,
  migrations: readonly MigrationMeta[],
  schema: SchemaInspection
) {
  if (schema.version >= 1 && schema.version <= 5) {
    return yield* new SqliteInitializationError({
      message: `Workflow Graph cannot adopt SQLite schema version ${schema.version}; versions 1-5 must be upgraded with an earlier Workflow Graph release first`,
    });
  }
  const expectedFingerprint = LEGACY_SCHEMA_FINGERPRINTS.get(schema.version);
  if (expectedFingerprint === undefined) {
    return yield* new SqliteInitializationError({
      message: `Workflow Graph cannot adopt SQLite schema version ${schema.version}`,
    });
  }
  if (schema.fingerprint !== expectedFingerprint) {
    return yield* new SqliteInitializationError({
      message: `Workflow Graph cannot adopt an unrecognized SQLite schema at version ${schema.version}`,
    });
  }

  const [baseline] = migrations;
  // Version 7 only added this index. Creating it idempotently lets the
  // supported version-6 database adopt the generated baseline safely.
  yield* database.run(
    sql.raw(`
    create index if not exists executions_workflow_in_flight_version_started_idx
    on workflow_executions(workflow_id, workflow_version_id, started_at)
    where status in ('pending', 'running', 'waiting')
  `)
  );
  yield* database.run(sql`
    create table ${sql.identifier(MIGRATIONS_TABLE)} (
      id integer primary key,
      hash text not null,
      created_at numeric,
      name text,
      applied_at text
    )
  `);
  yield* database.run(sql`
    insert into ${sql.identifier(MIGRATIONS_TABLE)}
      (hash, created_at, name, applied_at)
    values (
      ${baseline.hash}, ${baseline.folderMillis}, ${baseline.name},
      ${new Date().toISOString()}
    )
  `);
  yield* database.run(sql`pragma user_version = 0`);
  return undefined;
});

const validateCurrentSchema = Effect.fn("validateCurrentSqliteSchema")(
  function* (schema: SchemaInspection) {
    const tableNames = new Set(schema.tables.map((table) => table.name));
    const missingTables = EXPECTED_TABLES.filter(
      (table) => !tableNames.has(table)
    );
    if (missingTables.length > 0) {
      return yield* new SqliteInitializationError({
        message:
          "Workflow Graph's SQLite migration journal exists, but its application schema is incomplete",
      });
    }
    if (!CURRENT_SCHEMA_FINGERPRINTS.has(schema.fingerprint)) {
      return yield* new SqliteInitializationError({
        message:
          "Workflow Graph's SQLite application schema does not match its migration journal",
      });
    }
    return undefined;
  }
);

/** Runs Drizzle's generated statements while owning SQLite's FK lifecycle. */
export const runSqliteMigrations = Effect.fn("runSqliteMigrations")(function* (
  database: SqliteMigrationDatabase,
  migrationInput: readonly MigrationMeta[],
  initializeWorkflowGraphSchema = false
) {
  const migrations = migrationsFrom(migrationInput);
  yield* database.run(sql`pragma foreign_keys = on`);

  yield* Effect.acquireUseRelease(
    database.run(sql`pragma foreign_keys = off`),
    () =>
      database.transaction((transaction) =>
        Effect.gen(function* () {
          const existingViolations = new Set(
            (yield* transaction.all<ForeignKeyViolation>(
              sql`pragma foreign_key_check`
            )).map(violationKey)
          );

          if (initializeWorkflowGraphSchema) {
            const schema = yield* inspectSchema(transaction);
            const tableNames = new Set(
              schema.tables.map((table) => table.name)
            );
            if (!tableNames.has(MIGRATIONS_TABLE)) {
              const workflowGraphTables = EXPECTED_TABLES.filter((table) =>
                tableNames.has(table)
              );
              if (workflowGraphTables.length > 0) {
                yield* adoptLegacySchema(transaction, migrations, schema);
              }
            }
          }

          yield* transaction.run(sql`
            create table if not exists ${sql.identifier(MIGRATIONS_TABLE)} (
              id integer primary key,
              hash text not null,
              created_at numeric,
              name text,
              applied_at text
            )
          `);
          const pending = yield* validateMigrationJournal(
            transaction,
            migrations
          );
          for (const migration of pending) {
            for (const statement of migration.sql) {
              yield* transaction.run(sql.raw(statement));
            }
            yield* transaction.run(sql`
              insert into ${sql.identifier(MIGRATIONS_TABLE)}
                (hash, created_at, name, applied_at)
              values (
                ${migration.hash}, ${migration.folderMillis}, ${migration.name},
                ${new Date().toISOString()}
              )
            `);
          }

          const newViolations = (yield* transaction.all<ForeignKeyViolation>(
            sql`pragma foreign_key_check`
          )).filter(
            (violation) => !existingViolations.has(violationKey(violation))
          );
          if (newViolations.length > 0) {
            return yield* new SqliteInitializationError({
              message:
                "Workflow Graph's SQLite migrations introduced a foreign-key violation",
            });
          }
          if (initializeWorkflowGraphSchema) {
            yield* validateCurrentSchema(yield* inspectSchema(transaction));
          }
          return undefined;
        })
      ),
    () => database.run(sql`pragma foreign_keys = on`).pipe(Effect.orDie)
  );
});

export const initializeSqlite = Effect.fn("initializeSqlite")(function* (
  database: EffectSQLiteNodeDatabase
) {
  yield* database.run(sql`pragma foreign_keys = on`);
  yield* database.run(sql`pragma synchronous = normal`);
  yield* runSqliteMigrations(database, sqliteMigrations, true);
});
