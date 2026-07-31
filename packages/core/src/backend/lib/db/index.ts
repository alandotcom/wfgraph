import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import type { NormalizedDatabaseConfig } from "#src/backend/lib/db/config";
import {
  apiKeys,
  integrations,
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflowExecutionsRelations,
  workflows,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";

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

/** The one connection a migration run holds its advisory lock on. */
export function createMigrationClient(config: NormalizedDatabaseConfig): Sql {
  return createSqlClient(config, {
    max: MIGRATION_CONNECTIONS,
    applicationName: "rova-migrations",
  });
}

/**
 * The pool an app runs its queries on, and the Drizzle handle over it.
 *
 * `createRovaApp` builds one of these and hands the handle to the `Database`
 * Layer, so which connection a service queries on is decided by the app that owns
 * it rather than by whichever module happened to be imported first.
 */
export type DatabaseSurface = {
  /** The schema holding Rova's tables, which is what the migrator creates. */
  readonly schema: string;
  /** What every repository query runs on. */
  readonly db: RovaDatabase;
  /** The pool underneath, for the startup log line. */
  readonly client: Sql;
  /** Gives the pool back and releases this process's claim on the database. */
  close: () => Promise<void>;
};

/**
 * The surface a live app holds, or null when nothing does.
 *
 * One Rova per process (ADR-0002), and this is the guard that says so: while one
 * surface is open a second is refused, whatever it names. Letting an equivalent
 * config through would put two pools under one claim, and the first app disposed
 * would hand the claim back while the second was still querying, so a third app
 * naming somewhere else would be let in beside it. `close` gives the claim back,
 * which is what lets a host dispose an app and build another, and what keeps a
 * startup failure that already opened a pool from reading as a rebind.
 */
let claimedSurface: DatabaseSurface | null = null;

export function createDatabaseSurface(
  config: NormalizedDatabaseConfig
): DatabaseSurface {
  if (claimedSurface) {
    throw new Error(
      "A Rova database surface is already open in this process. Dispose the app holding it before creating another, or restart the process."
    );
  }

  // The pool is built before the claim is taken: postgres.js checks its options in
  // the constructor, and a claim taken first would survive a throw with no surface
  // left to release it.
  const client = createSqlClient(config, {
    max: config.maxConnections,
    applicationName: "rova",
  });

  const surface: DatabaseSurface = {
    schema: config.schema,
    db: drizzle(client, { schema: tables }),
    client,
    close: async () => {
      // Only this surface's own claim: a host that disposes an app twice would
      // otherwise release the claim of whichever app it built in between.
      if (claimedSurface === surface) {
        claimedSurface = null;
      }
      await client.end();
    },
  };

  claimedSurface = surface;
  return surface;
}

/**
 * Where a pool is pointed, for a log line. The fields come from postgres.js's own
 * parse rather than from the config, so a URL reports the host and database it
 * actually resolved to. The URL itself is never among them: it carries the
 * password.
 */
export function describeConnection(
  client: Sql,
  schema: string
): {
  schema: string;
  host: string;
  port: string;
  database: string;
  user: string;
} {
  const { options } = client;

  return {
    schema,
    host: options.host.join(","),
    port: options.port.join(","),
    database: options.database,
    user: options.user,
  };
}
