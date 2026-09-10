import { createHash } from "node:crypto";
import { Data, Effect, Exit } from "effect";
import { sql } from "drizzle-orm";
import type { EffectSQLiteNodeDatabase } from "drizzle-orm/effect-sqlite-node";
import type { MigrationMeta } from "drizzle-orm/migrator";
import { sqliteMigrations } from "#src/backend/persistence/sqlite/generated-migrations";

const MIGRATIONS_TABLE = "__wfgraph_sqlite_migrations";
const ENTITY_TERMINATION_MIGRATION = "20260910085613_jittery_madripoor";
const LEGACY_CANCEL_CLAIMS_TABLE = "__wfgraph_legacy_cancel_claims";
const LEGACY_SCHEMA_FINGERPRINTS = new Map([
  [6, "77261cee4c909093d042849e5bbd650020c27546c6f2cc6bcc38504ae7c3a839"],
  [7, "e73822bda63d0602c7a357a6fcd7e603df1eabc26db4da2de723a260ced7f225"],
]);
const CURRENT_SCHEMA_FINGERPRINTS = new Set([
  // A database created by all generated migrations.
  "164a0ad7d45f4cbcb3224f11a23e701d324c56624b025a0d3581222bd79256a0",
  // An adopted version-6 or version-7 database keeps its original table DDL.
  "0a7dbf55abf5155fd1825e9d4a9fe70dfa0f5442429fbe9294f0bd78d8e97154",
]);
const EXPECTED_TABLES = [
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
  "all" | "get" | "run"
>;

/**
 * Tries for an exclusive migration lock without joining SQLite's lock queue.
 * A queued second initializer can prevent the current holder from upgrading
 * its schema lock during a table rebuild, so contenders poll instead.
 */
function acquireExclusiveMigrationLock(
  database: SqliteMigrationDatabase,
  attemptsRemaining: number
): Effect.Effect<void, unknown> {
  return database
    .run(sql`begin exclusive`)
    .pipe(
      Effect.catch((error) =>
        attemptsRemaining <= 1
          ? Effect.fail(error)
          : Effect.sleep(10).pipe(
              Effect.flatMap(() =>
                acquireExclusiveMigrationLock(database, attemptsRemaining - 1)
              )
            )
      )
    );
}

function exclusiveMigrationTransaction<A, E>(
  database: SqliteMigrationDatabase,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, unknown> {
  const acquire = Effect.gen(function* () {
    const setting = yield* database.get<{ timeout: number }>(
      sql`pragma busy_timeout`
    );
    yield* database.run(sql`pragma busy_timeout = 0`);
    yield* acquireExclusiveMigrationLock(
      database,
      Math.max(1, Math.ceil(setting.timeout / 10))
    ).pipe(
      Effect.ensuring(
        database
          .run(sql.raw(`pragma busy_timeout = ${setting.timeout}`))
          .pipe(Effect.orDie)
      )
    );
  });

  return Effect.acquireUseRelease(
    acquire,
    () => effect,
    (_, exit) =>
      database
        .run(Exit.isSuccess(exit) ? sql`commit` : sql`rollback`)
        .pipe(Effect.orDie)
  );
}

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

/**
 * Holds legacy Cancel claim timestamps across the immutable Entity termination
 * migration, whose generated table rebuild removed their old column.
 */
const preserveLegacyCancelClaims = Effect.fn("preserveLegacyCancelClaims")(
  function* (
    database: SqliteMigrationDatabase,
    pending: readonly MigrationMeta[]
  ) {
    if (
      !pending.some(
        (migration) => migration.name === ENTITY_TERMINATION_MIGRATION
      )
    ) {
      return false;
    }

    const columns = yield* database.all<{ name: string }>(
      sql`select name from pragma_table_info('workflow_executions')`
    );
    if (!columns.some((column) => column.name === "cancel_requested_at")) {
      return false;
    }

    yield* database.run(
      sql.raw(`
      create temporary table ${LEGACY_CANCEL_CLAIMS_TABLE} as
      select id, cancel_requested_at
      from workflow_executions
      where cancel_requested_at is not null
    `)
    );
    return true;
  }
);

const restoreLegacyCancelClaims = Effect.fn("restoreLegacyCancelClaims")(
  function* (database: SqliteMigrationDatabase) {
    yield* database.run(
      sql.raw(`
      update workflow_executions
      set termination_kind = 'cancel',
          termination_requested_at = (
            select cancel_requested_at
            from ${LEGACY_CANCEL_CLAIMS_TABLE}
            where ${LEGACY_CANCEL_CLAIMS_TABLE}.id = workflow_executions.id
          )
      where id in (select id from ${LEGACY_CANCEL_CLAIMS_TABLE})
    `)
    );
    yield* database.run(sql.raw(`drop table ${LEGACY_CANCEL_CLAIMS_TABLE}`));
  }
);

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
      exclusiveMigrationTransaction(
        database,
        Effect.gen(function* () {
          const transaction = database;
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
          const preservedLegacyCancelClaims = yield* preserveLegacyCancelClaims(
            transaction,
            pending
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
          if (preservedLegacyCancelClaims) {
            yield* restoreLegacyCancelClaims(transaction);
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
