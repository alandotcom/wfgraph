import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
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

// packages/core/drizzle is the one copy of the migrations. drizzle-kit generates
// into it, "files" in packages/core/package.json publishes it, and each entry
// below is that same directory seen from a layout the code can run in.
// Nothing here is resolved from the working directory: an embedder who runs
// drizzle-kit themselves has their own ./drizzle beside it, and picking that up
// would run their migrations on Rova's connection. An operator whose migrations
// really do sit beside the process says so with database.migrations.migrationsDir.
const MIGRATIONS_DIR_CANDIDATES = [
  // Running from source, this file being packages/core/src/backend/lib/db/.
  resolve(currentDir, "../../../../drizzle"),
  // Installed as a package, this file being bundled into a chunk in the
  // package's dist/.
  resolve(currentDir, "../drizzle"),
];

export type MigrationsOptions = {
  /**
   * Apply every pending migration while the app starts, before it serves a
   * request; `createRovaApp` is what reads this. False unless the host says
   * otherwise, since whether a deployment migrates from its own instances or from
   * a step of its own is the deployment's decision. Several instances starting
   * together is safe either way: `runMigrations` holds an advisory lock and the
   * ones that lose the race wait, then find nothing to do.
   */
  runOnStartup?: boolean;
  /**
   * Directory holding the generated SQL, for an operator whose migrations really
   * do sit somewhere other than the copy Rova ships.
   */
  migrationsDir?: string;
};

async function resolveExistingMigrationsDir(
  configuredPath: string | undefined
): Promise<string> {
  const candidates = configuredPath
    ? [resolve(process.cwd(), configuredPath)]
    : MIGRATIONS_DIR_CANDIDATES;

  const findExistingCandidate = async (
    index: number
  ): Promise<string | null> => {
    const candidate = candidates[index];
    if (!candidate) {
      return null;
    }

    try {
      const stats = await stat(candidate);
      if (stats.isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep scanning candidates.
    }

    return findExistingCandidate(index + 1);
  };

  const existingCandidate = await findExistingCandidate(0);
  if (existingCandidate) {
    return existingCandidate;
  }

  throw new Error(
    `Migrations folder not found. Checked: ${candidates.join(", ")}.` +
      " If needed, pass database.migrations.migrationsDir to createRovaApp."
  );
}

/**
 * Applies every pending migration, on one connection holding one lock.
 *
 * The generated SQL names no schema, so the search_path the connection carries is
 * what puts the tables where the host asked for them, and the journal goes in
 * that same schema rather than one of its own: everything Rova owns then sits
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

  // One lock name per schema, so two Rovas sharing a database do not wait on each
  // other. hashtext turns it into the integer the lock functions take.
  const lockName = `rova:migrations:${schema}`;

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

  await migrate(migrationDb, {
    migrationsFolder: target.migrationsFolder,
    migrationsSchema: target.schema,
  });
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
      `The connection resolves unqualified names to ${current?.schema ?? "no schema"}, not the configured ${schema}. Rova sends the schema as a search_path startup parameter; a connection pooler in front of Postgres has to pass it through.`
    );
  }
}
