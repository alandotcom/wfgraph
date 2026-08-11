import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";
import type { NormalizedDatabaseConfig } from "#src/backend/lib/db/config";
import {
  createMigrationClient,
  describeConnection,
} from "#src/backend/lib/db/index";
import { getAppLogger } from "#src/backend/lib/logger";

const logger = getAppLogger("migrations");

const currentDir = dirname(fileURLToPath(import.meta.url));

/** The package these migrations belong to, named so the walk-up can recognise it. */
const OWNING_PACKAGE = "@wfgraph/core";

/** Drizzle's own journal table, which it creates inside `migrationsSchema`. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * `packages/core/drizzle`, found by walking up from this file to the package that
 * owns it.
 *
 * The one copy of the migrations: drizzle-kit generates into it, and "files" in
 * packages/core/package.json publishes it. Counting `..` segments instead would
 * be counting against a layout that only holds before bundling, and in a flat
 * node_modules the miscount lands on the adopter's own `drizzle/` -- which Workflow Graph's
 * migration connection would then apply into Workflow Graph's schema, under Workflow Graph's
 * search_path, with their hashes in Workflow Graph's journal. Anchoring on the package name
 * is what makes that unreachable rather than merely unlikely.
 *
 * An operator whose migrations really do sit somewhere else says so with
 * database.migrations.migrationsDir.
 */
export function wfgraphMigrationsDir(startDir: string = currentDir): string {
  const findPackageRoot = (dir: string): string => {
    const manifest = resolve(dir, "package.json");

    if (existsSync(manifest)) {
      const name: unknown = JSON.parse(readFileSync(manifest, "utf8")).name;
      if (name === OWNING_PACKAGE) {
        return dir;
      }

      throw new Error(
        `Workflow Graph's migrations are published inside ${OWNING_PACKAGE}, but the package holding its code is named ${String(name)}. Pass database.migrations.migrationsDir to createWfGraphApp to say where the SQL is.`
      );
    }

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find the ${OWNING_PACKAGE} package above ${startDir}, so Workflow Graph cannot locate the migrations it ships. Pass database.migrations.migrationsDir to createWfGraphApp.`
      );
    }

    return findPackageRoot(parent);
  };

  return resolve(findPackageRoot(startDir), "drizzle");
}

export type MigrationsOptions = {
  /**
   * Apply every pending migration while the app starts, before it serves a
   * request; `createWfGraphApp` is what reads this. False unless the host says
   * otherwise, since whether a deployment migrates from its own instances or from
   * a step of its own is the deployment's decision. Several instances starting
   * together is safe either way: `runMigrations` holds an advisory lock and the
   * ones that lose the race wait, then find nothing to do.
   */
  runOnStartup?: boolean;
  /**
   * Directory holding the generated SQL, for an operator whose migrations really
   * do sit somewhere other than the copy Workflow Graph ships.
   */
  migrationsDir?: string;
};

async function resolveExistingMigrationsDir(
  configuredPath: string | undefined
): Promise<string> {
  const folder = configuredPath
    ? resolve(process.cwd(), configuredPath)
    : wfgraphMigrationsDir();

  try {
    const stats = await stat(folder);
    if (stats.isDirectory()) {
      return folder;
    }
  } catch {
    // Falls through to the same sentence as a path that is not a directory.
  }

  throw new Error(
    `Migrations folder not found at ${folder}.` +
      " If needed, pass database.migrations.migrationsDir to createWfGraphApp."
  );
}

/**
 * Applies every pending migration, on one connection holding one lock.
 *
 * The generated SQL names no schema, so the search_path the connection carries is
 * what puts the tables where the host asked for them, and the journal goes in
 * that same schema rather than one of its own: everything Workflow Graph owns then sits
 * inside the one name a host can drop.
 *
 * The connection is this call's own, and it goes back before this returns whether
 * the migration worked or not. An app that migrates on the way up therefore holds
 * no second pool once it starts serving, and a one-shot migration process exits
 * rather than sitting on an idle socket.
 *
 * The advisory lock is what makes several instances starting together safe.
 * Postgres does not serialize concurrent `CREATE SCHEMA` or `CREATE TABLE` of the
 * same name; it fails the losers on a unique violation in `pg_namespace` or
 * `pg_type`, which is a crash loop for every replica but the first. The lock is
 * session-scoped, and holding it on the same session as the statements it guards
 * is what the migration pool's single connection buys: everything below runs
 * through that one client, which is that one session.
 */
export async function runMigrations(
  config: NormalizedDatabaseConfig,
  options: Pick<MigrationsOptions, "migrationsDir"> = {}
): Promise<void> {
  const migrationsFolder = await resolveExistingMigrationsDir(
    options.migrationsDir?.trim()
  );
  const { schema } = config;
  const client = createMigrationClient(config);

  logger.info("Running database migrations", {
    migrationsFolder,
    ...describeConnection(client, schema),
  });

  // One lock name per schema, so two WfGraphs sharing a database do not wait on each
  // other. hashtext turns it into the integer the lock functions take.
  const lockName = `wfgraph:migrations:${schema}`;

  try {
    await lockMigrations(client, lockName);
    try {
      await applyMigrations(client, { migrationsFolder, schema });
    } finally {
      await client`select pg_advisory_unlock(hashtext(${lockName}))`;
    }

    logger.info("Database migrations completed");
  } finally {
    await client.end();
  }
}

async function lockMigrations(client: Sql, lockName: string): Promise<void> {
  const [attempt] = await client<
    { locked: boolean }[]
  >`select pg_try_advisory_lock(hashtext(${lockName})) as locked`;

  if (attempt?.locked) {
    return;
  }

  // Said once, because the wait itself is silent and can outlast a deployment's
  // health-check window.
  logger.info("Waiting for another instance to finish migrating");
  await client`select pg_advisory_lock(hashtext(${lockName}))`;
}

async function applyMigrations(
  client: Sql,
  target: { migrationsFolder: string; schema: string }
): Promise<void> {
  const migrationDb = drizzle(client);

  // Drizzle's migrator creates the journal's schema itself, so this states the
  // precondition rather than carrying it: the tables need the schema to exist
  // before the first unqualified `CREATE TABLE`. On a first install one of the two
  // logs a duplicate-object notice, which is what `if not exists` is for.
  await migrationDb.execute(
    sql`create schema if not exists ${sql.identifier(target.schema)}`
  );

  await assertSearchPathHolds(client, target.schema);
  await assertJournalIsOurs(client, target);

  await migrate(migrationDb, {
    migrationsFolder: target.migrationsFolder,
    migrationsSchema: target.schema,
  });
}

async function assertJournalIsOurs(
  client: Sql,
  target: { migrationsFolder: string; schema: string }
): Promise<void> {
  const recorded = await client<{ hash: string }[]>`
    select hash from ${client(target.schema)}.${client(MIGRATIONS_TABLE)}
  `.catch(() => {
    // No journal table: this schema has never been migrated, which is the
    // ordinary first install.
    return [] as { hash: string }[];
  });

  assertJournalHashesAreOurs(
    recorded.map((row) => row.hash),
    target
  );
}

/**
 * Refuses a database whose journal records migrations this build does not ship.
 *
 * Drizzle v1 matches applied migrations by folder name after upgrading the
 * journal table, and only uses hashes while backfilling that name. A
 * rebaselined migration set therefore either fails the upgrade match or tries
 * to re-run `CREATE TABLE` against tables that already exist. The same rows
 * appear when another tool's `drizzle/` was applied here. Both need the schema
 * dropped, and neither is worth learning from a Postgres error code halfway
 * into a transaction.
 */
export function assertJournalHashesAreOurs(
  recorded: string[],
  target: { migrationsFolder: string; schema: string }
): void {
  const shipped = new Set(
    readMigrationFiles({ migrationsFolder: target.migrationsFolder }).map(
      (migration) => migration.hash
    )
  );
  const foreign = recorded.filter((hash) => !shipped.has(hash));

  if (foreign.length > 0) {
    throw new Error(
      `The ${target.schema} schema carries ${foreign.length} migration(s) this build of Workflow Graph does not ship, so applying the ones it does would re-run statements against objects that already exist. This happens when Workflow Graph's migration set was rebaselined, or when another tool's migrations were applied into this schema. Drop the ${target.schema} schema and migrate again.`
    );
  }
}

/**
 * The tables land wherever search_path points, so a connection that lost it would
 * migrate `public` without a word. A pooler is how that happens: PgBouncer drops
 * an unknown startup parameter unless it is told to track it.
 */
async function assertSearchPathHolds(
  client: Sql,
  schema: string
): Promise<void> {
  const [current] = await client<
    { schema: string | null }[]
  >`select current_schema() as schema`;

  if (current?.schema !== schema) {
    throw new Error(
      `The connection resolves unqualified names to ${current?.schema ?? "no schema"}, not the configured ${schema}. Workflow Graph sends the schema as a search_path startup parameter; a connection pooler in front of Postgres has to pass it through.`
    );
  }
}
