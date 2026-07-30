import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
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

const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";
const DEFAULT_DATABASE_SCHEMA = "_workflows";
const DEFAULT_QUERY_CONNECTIONS = 10;
// One connection, and load-bearing: the advisory lock runMigrations takes is
// session-scoped, and a pool of one is what puts the lock and the statements it
// guards on the same session. A second connection would let the DDL run unguarded.
const MIGRATION_CONNECTIONS = 1;
const MAX_IDENTIFIER_LENGTH = 63;
const MAX_PORT = 65_535;

/** The options both spellings of the connection take. */
type DatabaseCommonConfig = {
  /**
   * Postgres schema Rova keeps its tables in, "_workflows" unless the host says
   * otherwise. Rova creates it when it migrates and holds every table and the
   * migration journal inside it, so dropping this one schema removes Rova from
   * the database. Lowercase only: an unquoted identifier in `search_path` folds
   * to lowercase, so a mixed-case name would silently mean a different schema
   * than the one written here.
   */
  schema?: string;
  /** Connections the query pool may open. Defaults to 10. */
  maxConnections?: number;
  /**
   * How to reach the server over TLS. An explicit value here outranks an
   * `sslmode` in the URL, which is why it is left out of the options handed to
   * postgres.js when the host said nothing.
   */
  ssl?: boolean | "require" | "allow" | "prefer" | "verify-full";
};

/**
 * Where the database is, spelled either as one URL or as the discrete fields a
 * platform hands out separately. The `never`s are what make the two arms
 * exclusive: a literal carrying both fails to compile, and `normalizeRuntimeConfig`
 * refuses the same mixture at runtime for a host who is not on TypeScript.
 */
export type DatabaseRuntimeConfig =
  | (DatabaseCommonConfig & {
      url: string;
      host?: never;
      port?: never;
      user?: never;
      password?: never;
      database?: never;
    })
  | (DatabaseCommonConfig & {
      url?: never;
      host: string;
      port?: number;
      user: string;
      password?: string;
      database: string;
    });

/** The two arms above, read as the one set of fields they draw from. */
type DatabaseConnectionFields = {
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
};

/**
 * What the clients are built from: the host's connection fields as given, never
 * rewritten into some other spelling. An earlier version folded the discrete
 * fields into a URL, which quietly broke a database name holding a space
 * (postgres.js decodes a URL's user and password but not its path segment), an
 * IPv6 or unix-socket host, and TLS.
 */
type NormalizedDatabaseConfig = DatabaseConnectionFields & {
  schema: string;
  maxConnections: number;
  ssl?: boolean | "require" | "allow" | "prefer" | "verify-full";
};

const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_$]*$/;
// Everything Postgres or a URL would read as the end of a host name. A host
// carrying one of these means a field arrived holding something else entirely.
const HOST_SEPARATORS = /[:/?@\s]/;

function normalizeSchemaName(name: string): string {
  const schemaName = name.trim();

  if (!SCHEMA_NAME_PATTERN.test(schemaName)) {
    throw new Error(
      "database.schema must be an unquoted lowercase Postgres identifier: a letter or underscore first, then letters, digits, underscores or $."
    );
  }

  // Postgres truncates an identifier past 63 bytes, so a longer name would
  // address a schema that getDatabaseSchema() reports under its full spelling.
  if (schemaName.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(
      `database.schema must be at most ${MAX_IDENTIFIER_LENGTH} characters, which is where Postgres truncates an identifier.`
    );
  }

  return schemaName;
}

function refuseSearchPathInUrl(): never {
  throw new Error(
    "database.url may not carry a search_path. Naming the schema is database.schema's job, and the two would disagree."
  );
}

/**
 * postgres.js sends a URL's unrecognized query parameters in the startup packet,
 * and they outrank the options given in code, so a search_path written there
 * would decide where the tables go while the migrator went on creating the schema
 * `database.schema` names. The parameters are read parsed rather than as a
 * substring: percent-encoding hides `search%5Fpath` from a substring test, and a
 * password is free to contain anything at all.
 */
function assertNoSearchPathInUrl(url: string): void {
  let parameters: URLSearchParams;
  try {
    parameters = new URL(url).searchParams;
  } catch {
    // postgres.js accepts shapes the URL parser rejects, a multi-host string
    // among them. Whether the rest of it parses is postgres.js's to report.
    if (url.toLowerCase().includes("search_path")) {
      refuseSearchPathInUrl();
    }
    return;
  }

  for (const [key, value] of parameters) {
    const parameter = key.toLowerCase();
    if (
      parameter === "search_path" ||
      (parameter === "options" && value.toLowerCase().includes("search_path"))
    ) {
      refuseSearchPathInUrl();
    }
  }
}

function normalizeConnectionCount(
  value: number | undefined,
  fallback: number
): number {
  if (!value || Number.isNaN(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

/** The connection fields, checked and with the empty spellings dropped. */
function normalizeConnection(
  config: DatabaseRuntimeConfig
): DatabaseConnectionFields {
  const fields: DatabaseConnectionFields = config;
  const url = fields.url?.trim();
  const host = fields.host?.trim();
  const user = fields.user?.trim();
  const database = fields.database?.trim();

  if (url) {
    if (host || user || database || fields.password || fields.port) {
      throw new Error(
        "Database configuration takes either database.url or the discrete host, port, user, password and database fields, not both."
      );
    }

    assertNoSearchPathInUrl(url);
    return { url };
  }

  if (!host || !user || !database) {
    throw new Error(
      "Database configuration needs either database.url, or all of database.host, database.user and database.database."
    );
  }

  if (HOST_SEPARATORS.test(host)) {
    throw new Error(
      "database.host takes a host name or address on its own. A port belongs in database.port, and a connection string in database.url."
    );
  }

  const { port, password } = fields;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > MAX_PORT)
  ) {
    throw new Error(
      `database.port must be a whole number between 1 and ${MAX_PORT}.`
    );
  }

  return { host, port, user, password, database };
}

function normalizeRuntimeConfig(
  config: DatabaseRuntimeConfig
): NormalizedDatabaseConfig {
  return {
    ...normalizeConnection(config),
    schema: normalizeSchemaName(config.schema ?? DEFAULT_DATABASE_SCHEMA),
    maxConnections: normalizeConnectionCount(
      config.maxConnections,
      DEFAULT_QUERY_CONNECTIONS
    ),
    ssl: config.ssl,
  };
}

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
 * Nothing having configured the runtime leaves the environment to answer, which
 * is the standalone migration script's path: it reaches a client without building
 * an app. That reading goes through the same normalizer as a host's own config, so
 * a `DATABASE_URL` carrying a search_path is refused there too rather than
 * migrating one schema and querying another.
 */
function resolveDatabaseConfig(): NormalizedDatabaseConfig {
  return (
    databaseState.config ??
    normalizeRuntimeConfig({
      url: process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL,
      schema: process.env.DATABASE_SCHEMA?.trim() || undefined,
    })
  );
}

function areConfigsEquivalent(
  left: NormalizedDatabaseConfig,
  right: NormalizedDatabaseConfig
): boolean {
  return (
    left.url === right.url &&
    left.host === right.host &&
    left.port === right.port &&
    left.user === right.user &&
    left.password === right.password &&
    left.database === right.database &&
    left.ssl === right.ssl &&
    left.schema === right.schema &&
    left.maxConnections === right.maxConnections
  );
}

/**
 * Refuse a database config before the caller has changed anything about the
 * process, which is why `createRovaApp` runs this beside its other startup
 * assertions rather than waiting for `configureDatabaseRuntime` a few steps
 * later. Three things fail here: a config naming no database, a URL carrying a
 * search_path of its own, and a schema name Postgres would not read back the way
 * it was written.
 */
export function assertDatabaseConfig(config: DatabaseRuntimeConfig): void {
  void normalizeRuntimeConfig(config);
}

export function configureDatabaseRuntime(config: DatabaseRuntimeConfig): void {
  const normalizedConfig = normalizeRuntimeConfig(config);

  // A config already recorded but no handle opened yet is still a second app
  // claiming the process. Overwriting it here would let the first app's services
  // query the second app's database the moment something opens the pool, which
  // is the same collision the initialized branch below refuses.
  if (databaseState.config && !databaseState.db && !databaseState.queryClient) {
    if (areConfigsEquivalent(databaseState.config, normalizedConfig)) {
      return;
    }

    throw new Error(
      "Database runtime is already configured with a different configuration. Restart the process to apply a new database config."
    );
  }

  if (
    databaseState.db ||
    databaseState.queryClient ||
    databaseState.migrationClient
  ) {
    const currentConfig = resolveDatabaseConfig();
    if (areConfigsEquivalent(currentConfig, normalizedConfig)) {
      return;
    }

    throw new Error(
      "Database runtime is already initialized with a different configuration. Restart the process to apply a new database config."
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
 * Back to nothing configured, pools closed. This is what a test stands on: the
 * state below is process-global and vitest shares a worker between files, so a
 * config left behind is the one the next file's `configureDatabaseRuntime`
 * refuses to rebind.
 */
export async function resetDatabaseRuntime(): Promise<void> {
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
