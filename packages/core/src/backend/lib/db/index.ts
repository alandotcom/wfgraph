import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Notice, type Sql } from "postgres";
import type { NormalizedDatabaseConfig } from "#src/backend/lib/db/config";
import { relations } from "#src/backend/lib/db/schema";
import { getAppLogger } from "#src/backend/lib/logger";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";

/**
 * The Drizzle handle, with this app's relational config attached. The `Database`
 * service in `backend/lib/effect/database.ts` hands one of these to every query
 * it runs.
 */
export type WfGraphDatabase = PostgresJsDatabase<typeof relations>;

/**
 * The handle inside `db.transaction(...)`, named by asking the handle itself.
 *
 * Drizzle's own transaction type takes four generic parameters that have to agree
 * with the ones `WfGraphDatabase` was built from, and naming them again is how those
 * drift. A repository writing part of a query inside a transaction and part
 * outside takes this beside `WfGraphDatabase`.
 */
export type WfGraphTransaction = Parameters<
  Parameters<WfGraphDatabase["transaction"]>[0]
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
 * is there because Workflow Graph now cohabits a host's database and its connections should
 * be attributable in `pg_stat_activity`.
 */
const logger = getAppLogger("database");

function createSqlClient(
  config: NormalizedDatabaseConfig,
  pool: { max: number; applicationName: string }
): Sql {
  // postgres.js tests for each option with `in`, so a key holding undefined is
  // not the same to it as an absent key: an `host: undefined` would outrank the
  // host the URL carries. `omitUndefined` drops whatever the config left out.
  // The options are named here rather than written inline, because inline the
  // library's own parameter type would drive the inference and the keys would
  // survive.
  const options = omitUndefined({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    // An `ssl: undefined` is not the same as no ssl key at all: postgres.js tests
    // for the option with `in`, so an explicit undefined would outrank an
    // `sslmode` the URL carries. `omitUndefined` above drops the key outright.
    ssl: config.ssl,
    max: pool.max,
    connection: {
      search_path: config.schema,
      application_name: pool.applicationName,
    },
    // postgres.js prints a notice with `console.log` unless it is given
    // somewhere else to put one, and migrating raises several. Printing them is
    // this library writing to a host's stdout in a shape nothing configured,
    // which ADR-0013 exists to avoid. They are the server's own notices, so
    // this logs them at debug.
    onnotice: (notice: Notice) => {
      logger.debug("PostgreSQL notice", {
        postgres: {
          code: notice.code,
          severity: notice.severity,
          message: notice.message,
        },
      });
    },
  });

  return postgres(config.url ?? "", options);
}

/** The one connection a migration run holds its advisory lock on. */
export function createMigrationClient(config: NormalizedDatabaseConfig): Sql {
  return createSqlClient(config, {
    max: MIGRATION_CONNECTIONS,
    applicationName: "wfgraph-migrations",
  });
}

/**
 * The pool an app runs its queries on, and the Drizzle handle over it.
 *
 * `createWfGraphApp` builds one of these and hands the handle to the `Database`
 * Layer, so which connection a service queries on is decided by the app that owns
 * it rather than by whichever module happened to be imported first.
 */
export type DatabaseSurface = {
  /** The schema holding Workflow Graph's tables, which is what the migrator creates. */
  readonly schema: string;
  /** What every repository query runs on. */
  readonly db: WfGraphDatabase;
  /** The pool underneath, for the startup log line. */
  readonly client: Sql;
  /** Gives the app-owned pool back. */
  close: () => Promise<void>;
};

/**
 * Builds the database surface one app owns.
 *
 * No process-level registry retains the handle. The app threads this value into
 * its own Layer graph and closes the same pool when disposed.
 */
export function createDatabaseSurface(
  config: NormalizedDatabaseConfig
): DatabaseSurface {
  const client = createSqlClient(config, {
    max: config.maxConnections,
    applicationName: "wfgraph",
  });

  const surface: DatabaseSurface = {
    schema: config.schema,
    db: drizzle({ client, relations }),
    client,
    close: () => client.end(),
  };

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
