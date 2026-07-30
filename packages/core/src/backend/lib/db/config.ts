/**
 * What a host may say about where its database is, and the one function that
 * checks it.
 *
 * Nothing here holds state or opens a socket. `db/index.ts` owns the pools and
 * takes an already-normalized config, so a caller that wants the checks without
 * the consequences -- `createRovaApp`, which refuses a bad config before it has
 * changed anything about the process -- runs `normalizeDatabaseConfig` on its own.
 */

const DEFAULT_DATABASE_SCHEMA = "_workflows";
const DEFAULT_QUERY_CONNECTIONS = 10;
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
 * exclusive: a literal carrying both fails to compile, and `normalizeDatabaseConfig`
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
export type NormalizedDatabaseConfig = DatabaseConnectionFields & {
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

/**
 * A host's config, checked and filled in.
 *
 * Three things fail here: a config naming no database, a URL carrying a
 * search_path of its own, and a schema name Postgres would not read back the way
 * it was written.
 */
export function normalizeDatabaseConfig(
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

/** Whether two normalized configs name the same database on the same terms. */
export function areConfigsEquivalent(
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
