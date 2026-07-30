import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { areConfigsEquivalent, type NormalizedDatabaseConfig } from "./config";
import {
  apiKeys,
  integrations,
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflowExecutionsRelations,
  workflows,
  workflowWaitStates,
} from "./schema";

const tables: {
  workflows: typeof workflows;
  workflowExecutions: typeof workflowExecutions;
  workflowExecutionLogs: typeof workflowExecutionLogs;
  workflowExecutionEvents: typeof workflowExecutionEvents;
  workflowExecutionsRelations: typeof workflowExecutionsRelations;
  workflowWaitStates: typeof workflowWaitStates;
  apiKeys: typeof apiKeys;
  integrations: typeof integrations;
} = {
  workflows,
  workflowExecutions,
  workflowExecutionLogs,
  workflowExecutionEvents,
  workflowExecutionsRelations,
  workflowWaitStates,
  apiKeys,
  integrations,
};

/**
 * The Drizzle handle, with this app's tables attached. The `Database` service in
 * `backend/lib/effect/database.ts` hands one of these to every query it runs.
 */
export type RovaDatabase = PostgresJsDatabase<typeof tables>;

/**
 * The handle inside `db.transaction(...)`, named by asking the handle itself.
 *
 * Drizzle's own transaction type takes four generic parameters that have to agree
 * with the ones `RovaDatabase` was built from, and naming them again is how those
 * drift. A repository writing part of a query inside a transaction and part
 * outside takes this beside `RovaDatabase`.
 */
export type RovaTransaction = Parameters<
  Parameters<RovaDatabase["transaction"]>[0]
>[0];

// One connection, and load-bearing: the advisory lock runMigrations takes is
// session-scoped, and a pool of one is what puts the lock and the statements it
// guards on the same session. A second connection would let the DDL run unguarded.
const MIGRATION_CONNECTIONS = 1;

/**
 * A pool pointed at the configured schema.
 *
 * The tables are declared unqualified (`db/schema.ts`), so the search_path is
 * what decides where they live. It travels in the startup packet rather than as a
 * `SET` on checkout, which is what makes every connection the pool opens, and
 * every one it reopens after a network drop, already correct. `application_name`
 * is there because Rova now cohabits a host's database and its connections should
 * be attributable in `pg_stat_activity`.
 */
function createSqlClient(
  config: NormalizedDatabaseConfig,
  pool: { max: number; applicationName: string }
): Sql {
  return postgres(config.url ?? "", {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    // An `ssl: undefined` is not the same as no ssl key at all: postgres.js tests
    // for the option with `in`, so an explicit undefined would outrank an
    // `sslmode` the URL carries.
    ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
    max: pool.max,
    connection: {
      search_path: config.schema,
      application_name: pool.applicationName,
    },
  });
}

type DatabaseRuntimeState = {
  /** Normalized on the way in, so two configs compare field by field. */
  config: NormalizedDatabaseConfig | null;
  queryClient: Sql | null;
  migrationClient: Sql | null;
  db: PostgresJsDatabase<typeof tables> | null;
};

declare global {
  var __rovaDatabaseState: DatabaseRuntimeState | undefined;
}

const databaseState: DatabaseRuntimeState = globalThis.__rovaDatabaseState ?? {
  config: null,
  queryClient: null,
  migrationClient: null,
  db: null,
};

globalThis.__rovaDatabaseState = databaseState;

/**
 * The config the clients are built from.
 *
 * Every entry point configures the runtime before reaching a client: an app
 * through `createRovaApp`, a migration job through `migrateRovaDatabase`. So an
 * unset config means a caller reached a pool outside either, and the throw names
 * that rather than opening a connection to whatever `DATABASE_URL` happened to
 * hold. Where the dev database is belongs to the script that runs against it,
 * which is why `scripts/migrate.ts` carries that default.
 */
function resolveDatabaseConfig(): NormalizedDatabaseConfig {
  if (!databaseState.config) {
    throw new Error(
      "The database runtime has not been configured. createRovaApp and migrateRovaDatabase each do it, so reaching a connection without one means neither ran."
    );
  }

  return databaseState.config;
}

/**
 * Record where the database is, or refuse a second app that says somewhere else.
 *
 * A config already recorded is a claim on the process whether or not a pool has
 * been opened against it yet: overwriting one would let the first app's services
 * query the second app's database the moment something opens the pool.
 * `closeDatabaseRuntime` is what gives the claim back, which is why a host that
 * disposes an app can build another.
 */
export function configureDatabaseRuntime(
  normalizedConfig: NormalizedDatabaseConfig
): void {
  const currentConfig = databaseState.config;

  if (currentConfig) {
    if (areConfigsEquivalent(currentConfig, normalizedConfig)) {
      return;
    }

    throw new Error(
      "Database runtime is already configured with a different configuration. Restart the process to apply a new database config."
    );
  }

  databaseState.config = normalizedConfig;
}

/** The schema holding Rova's tables, which is what the migrator creates. */
export function getDatabaseSchema(): string {
  return resolveDatabaseConfig().schema;
}

/** The pool every query the app runs goes through. */
export function getQueryClient(): Sql {
  if (databaseState.queryClient) {
    return databaseState.queryClient;
  }

  const config = resolveDatabaseConfig();
  databaseState.queryClient = createSqlClient(config, {
    max: config.maxConnections,
    applicationName: "rova",
  });

  return databaseState.queryClient;
}

export function getMigrationClient(): Sql {
  if (databaseState.migrationClient) {
    return databaseState.migrationClient;
  }

  databaseState.migrationClient = createSqlClient(resolveDatabaseConfig(), {
    max: MIGRATION_CONNECTIONS,
    applicationName: "rova-migrations",
  });

  return databaseState.migrationClient;
}

/**
 * Where a pool is pointed, for a log line. The fields come from postgres.js's own
 * parse rather than from the config, so a URL reports the host and database it
 * actually resolved to. The URL itself is never among them: it carries the
 * password.
 */
export function describeConnection(client: Sql): {
  schema: string;
  host: string;
  port: string;
  database: string;
  user: string;
} {
  const { options } = client;

  return {
    schema: getDatabaseSchema(),
    host: options.host.join(","),
    port: options.port.join(","),
    database: options.database,
    user: options.user,
  };
}

export function getDb(): PostgresJsDatabase<typeof tables> {
  if (databaseState.db) {
    return databaseState.db;
  }

  databaseState.db = drizzle(getQueryClient(), { schema: tables });

  return databaseState.db;
}

/**
 * Gives the migration pool back. A one-shot migration process has to do this to
 * exit at all, since postgres.js keeps an idle socket open, and an app that
 * migrated on the way up has no further use for the pool.
 */
export async function closeMigrationClient(): Promise<void> {
  const client = databaseState.migrationClient;
  databaseState.migrationClient = null;
  await client?.end();
}

/**
 * Back to nothing configured, both pools closed.
 *
 * `createRovaApp`'s dispose calls this, which is what lets a host that shuts Rova
 * down get its process back: postgres.js keeps an idle socket open per pool, and
 * a migration on the way up leaves a second one behind. A test stands on the same
 * function, because the state below is process-global and vitest shares a worker
 * between files, so a config left behind is the one the next file's
 * `configureDatabaseRuntime` refuses to rebind.
 */
export async function closeDatabaseRuntime(): Promise<void> {
  const clients = [databaseState.queryClient, databaseState.migrationClient];

  databaseState.config = null;
  databaseState.queryClient = null;
  databaseState.migrationClient = null;
  databaseState.db = null;

  await Promise.all(clients.map(async (client) => await client?.end()));
}

const dbProxy: PostgresJsDatabase<typeof tables> = new Proxy(
  Object.create(null),
  {
    get(_target, property, receiver) {
      const instance = getDb();
      const value = Reflect.get(instance, property, receiver);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  }
);

export const db: PostgresJsDatabase<typeof tables> = dbProxy;
