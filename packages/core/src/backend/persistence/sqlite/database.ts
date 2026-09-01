import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { isSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import {
  WORKFLOW_VERSION_KINDS,
  type WorkflowVersionKind,
} from "@wfgraph/shared/graph/version-kinds";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import {
  readJsonObject,
  readJsonValue,
  type JsonObject,
  type JsonValue,
} from "@wfgraph/shared/types/json";

const SCHEMA_VERSION = 6;

/** Safe SQL literals from the closed execution-status vocabulary in shared. */
export const SQLITE_IN_FLIGHT_EXECUTION_STATUSES =
  IN_FLIGHT_EXECUTION_STATUSES.map((status) => `'${status}'`).join(", ");

const MIGRATION_1 = `
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT,
    graph TEXT NOT NULL,
    is_paused INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0, 1)),
    mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'test')),
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    published_version_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (published_version_id) REFERENCES workflow_versions(id) ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE workflow_versions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version INTEGER,
    kind TEXT NOT NULL DEFAULT 'published' CHECK (kind IN ('published', 'draft_snapshot')),
    graph TEXT NOT NULL,
    catalog_fingerprint TEXT NOT NULL,
    graph_digest TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    UNIQUE (workflow_id, version)
  ) STRICT;

  CREATE TABLE workflow_event_subscriptions (
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    event_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('start', 'cancel', 'wait')),
    correlation_path TEXT,
    PRIMARY KEY (workflow_id, event_name, role)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE workflow_executions (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
    workflow_run_id TEXT UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'canceled', 'superseded')),
    start_source TEXT CHECK (start_source IS NULL OR start_source IN ('event', 'manual', 'schedule')),
    delivery_id TEXT,
    enqueued_at INTEGER,
    run_mode TEXT NOT NULL DEFAULT 'live' CHECK (run_mode IN ('live', 'test')),
    start_event_name TEXT,
    entity_value TEXT,
    input TEXT CHECK (input IS NULL OR json_valid(input)),
    output TEXT CHECK (output IS NULL OR json_valid(output)),
    error TEXT,
    started_at INTEGER NOT NULL,
    waiting_at INTEGER,
    cancelled_at INTEGER,
    completed_at INTEGER,
    duration TEXT,
    cancel_requested_at INTEGER,
    cancel_event_name TEXT,
    cancel_payload TEXT CHECK (cancel_payload IS NULL OR json_valid(cancel_payload)),
    UNIQUE (workflow_id, delivery_id)
  ) STRICT;

  CREATE TABLE workflow_execution_logs (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    node_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'error', 'cancelled')),
    input TEXT CHECK (input IS NULL OR json_valid(input)),
    output TEXT CHECK (output IS NULL OR json_valid(output)),
    error TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration TEXT,
    timestamp INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE workflow_wait_states (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    wait_type TEXT NOT NULL CHECK (wait_type IN ('delay', 'event')),
    status TEXT NOT NULL CHECK (status IN ('waiting', 'resuming', 'resumed', 'timed_out', 'cancelled')),
    resume_token TEXT UNIQUE,
    wait_until INTEGER,
    subscribed_events TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(subscribed_events) AND json_type(subscribed_events) = 'array'),
    metadata TEXT CHECK (metadata IS NULL OR (json_valid(metadata) AND json_type(metadata) = 'object')),
    created_at INTEGER NOT NULL,
    resumed_at INTEGER,
    cancelled_at INTEGER
  ) STRICT;

  CREATE TABLE workflow_execution_events (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    execution_id TEXT REFERENCES workflow_executions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata TEXT CHECK (metadata IS NULL OR (json_valid(metadata) AND json_type(metadata) = 'object')),
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  ) STRICT;

  CREATE TABLE integrations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    is_managed INTEGER DEFAULT 0 CHECK (is_managed IS NULL OR is_managed IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX api_keys_prefix_idx ON api_keys(key_prefix);
  CREATE INDEX integrations_type_idx ON integrations(type);
  CREATE INDEX subscriptions_event_idx ON workflow_event_subscriptions(event_name);
  CREATE INDEX executions_workflow_started_idx ON workflow_executions(workflow_id, started_at DESC, id DESC);
  CREATE INDEX executions_started_idx ON workflow_executions(started_at DESC, id DESC);
  CREATE INDEX executions_entity_idx ON workflow_executions(workflow_id, entity_value, run_mode, status);
  CREATE INDEX logs_execution_timestamp_idx ON workflow_execution_logs(execution_id, timestamp DESC);
  CREATE INDEX waits_execution_status_idx ON workflow_wait_states(execution_id, status);
  CREATE INDEX waits_workflow_status_idx ON workflow_wait_states(workflow_id, status);
  CREATE INDEX events_execution_created_idx ON workflow_execution_events(execution_id, created_at DESC);
  CREATE INDEX events_workflow_created_idx ON workflow_execution_events(workflow_id, created_at DESC);
`;

/**
 * Every migration below is frozen text: it names its own values rather than
 * reading a constant. A database already past this version never runs it again,
 * so interpolating `INTEGRATION_REFRESH_STATES` would let a fourth state reach
 * a fresh database's CHECK and no existing one's -- the two would then disagree
 * about what `refresh_state` may hold, with nothing failing at build time.
 * Widening this column takes a new migration.
 * `sqlite.integrations.test.ts` is what holds the pair together.
 */
const MIGRATION_2 = `
  ALTER TABLE integrations
    ADD COLUMN refresh_state TEXT NOT NULL DEFAULT 'idle'
    CHECK (refresh_state IN ('idle', 'refreshing', 'reauthorization_required'));
  ALTER TABLE integrations ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE integrations ADD COLUMN refresh_claim_id TEXT;
  ALTER TABLE integrations ADD COLUMN refresh_claimed_at INTEGER;

  CREATE TABLE oauth_authorization_attempts (
    state_hash TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    browser_binding_hash TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX oauth_attempts_integration_idx
    ON oauth_authorization_attempts(integration_id);
  CREATE INDEX oauth_attempts_expires_at_idx
    ON oauth_authorization_attempts(expires_at);
`;

const MIGRATION_3 = `
  DROP INDEX oauth_attempts_integration_idx;
  DROP INDEX oauth_attempts_expires_at_idx;
  ALTER TABLE oauth_authorization_attempts RENAME TO oauth_authorization_attempts_v2;

  CREATE TABLE oauth_authorization_attempts (
    state_hash TEXT PRIMARY KEY,
    integration_id TEXT REFERENCES integrations(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    browser_binding_hash TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  INSERT INTO oauth_authorization_attempts
    (state_hash, integration_id, expires_at, browser_binding_hash, encrypted_payload, created_at)
  SELECT state_hash, integration_id, expires_at, browser_binding_hash, encrypted_payload, created_at
  FROM oauth_authorization_attempts_v2;
  DROP TABLE oauth_authorization_attempts_v2;

  CREATE INDEX oauth_attempts_integration_idx
    ON oauth_authorization_attempts(integration_id);
  CREATE INDEX oauth_attempts_expires_at_idx
    ON oauth_authorization_attempts(expires_at);
`;

const MIGRATION_4 = `
  DROP INDEX oauth_attempts_integration_idx;
  DROP INDEX oauth_attempts_expires_at_idx;
  ALTER TABLE oauth_authorization_attempts RENAME TO oauth_authorization_attempts_v3;

  CREATE TABLE oauth_authorization_attempts (
    state_hash TEXT PRIMARY KEY,
    integration_id TEXT REFERENCES integrations(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    browser_binding_hash TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('create', 'reconnect')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
    result_integration_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  INSERT INTO oauth_authorization_attempts
    (state_hash, integration_id, expires_at, browser_binding_hash, encrypted_payload,
     mode, status, result_integration_id, created_at, updated_at)
  SELECT state_hash, integration_id, expires_at, browser_binding_hash, encrypted_payload,
         CASE WHEN integration_id IS NULL THEN 'create' ELSE 'reconnect' END,
         'pending', NULL, created_at, created_at
  FROM oauth_authorization_attempts_v3;
  DROP TABLE oauth_authorization_attempts_v3;

  CREATE INDEX oauth_attempts_integration_idx
    ON oauth_authorization_attempts(integration_id);
  CREATE INDEX oauth_attempts_expires_at_idx
    ON oauth_authorization_attempts(expires_at);
`;

/**
 * Adds draft snapshots: `version` becomes nullable and `kind` names the sort of
 * row. SQLite cannot drop a NOT NULL constraint, so this rebuilds the table.
 *
 * Two tables carry a foreign key into this one. The rebuild therefore creates
 * the replacement under a temporary name and renames it into place last, and
 * `migrate` runs this step with foreign keys off. Dropping the old table with
 * foreign keys on would cascade every execution row away, and renaming the old
 * table out of the way first would rewrite those foreign keys to follow it.
 */
const MIGRATION_5 = `
  CREATE TABLE workflow_versions_v2 (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version INTEGER,
    kind TEXT NOT NULL DEFAULT 'published' CHECK (kind IN ('published', 'draft_snapshot')),
    graph TEXT NOT NULL,
    catalog_fingerprint TEXT NOT NULL,
    graph_digest TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    UNIQUE (workflow_id, version)
  ) STRICT;

  INSERT INTO workflow_versions_v2
    (id, workflow_id, version, kind, graph, catalog_fingerprint, graph_digest, published_at)
  SELECT id, workflow_id, version, 'published', graph, catalog_fingerprint,
         graph_digest, published_at
  FROM workflow_versions;

  DROP TABLE workflow_versions;
  ALTER TABLE workflow_versions_v2 RENAME TO workflow_versions;
`;

/**
 * The Connection a start or cancel Event must arrive on, denormalized the
 * same way Correlation Path already is. Incomplete upgrade fixtures may lack
 * this table, so the create is what lets them reach the column add.
 */
const MIGRATION_6 = `
  CREATE TABLE IF NOT EXISTS workflow_event_subscriptions (
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    event_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('start', 'cancel', 'wait')),
    correlation_path TEXT,
    PRIMARY KEY (workflow_id, event_name, role)
  ) STRICT, WITHOUT ROWID;
  ALTER TABLE workflow_event_subscriptions ADD COLUMN connection_id TEXT;
`;

export type SqliteDatabase = {
  readonly read: <A>(
    run: (database: DatabaseSync) => A
  ) => Effect.Effect<A, DatabaseError>;
  readonly write: <A>(
    run: (database: DatabaseSync) => A
  ) => Effect.Effect<A, DatabaseError>;
  readonly close: () => Promise<void>;
};

function attempt<A>(run: () => A): Effect.Effect<A, DatabaseError> {
  return Effect.try({
    try: run,
    catch: (cause) => new DatabaseError({ cause }),
  });
}

function inImmediateTransaction<A>(database: DatabaseSync, run: () => A): A {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrate(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get();
  const version = row?.user_version;
  if (typeof version !== "number") {
    throw new Error("SQLite did not return its schema version");
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `Workflow Graph cannot read SQLite schema version ${version}`
    );
  }
  if (version === 0) {
    inImmediateTransaction(database, () => {
      database.exec(MIGRATION_1);
      database.exec("PRAGMA user_version = 1");
    });
  }
  if (version <= 1) {
    inImmediateTransaction(database, () => {
      database.exec(MIGRATION_2);
      database.exec("PRAGMA user_version = 2");
    });
  }
  if (version <= 2) {
    inImmediateTransaction(database, () => {
      database.exec(MIGRATION_3);
      database.exec("PRAGMA user_version = 3");
    });
  }
  if (version <= 3) {
    inImmediateTransaction(database, () => {
      database.exec(MIGRATION_4);
      database.exec("PRAGMA user_version = 4");
    });
  }
  if (version <= 4) {
    rebuildTable(database, () => {
      database.exec(MIGRATION_5);
      database.exec("PRAGMA user_version = 5");
    });
  }
  if (version <= 5) {
    inImmediateTransaction(database, () => {
      database.exec(MIGRATION_6);
      database.exec("PRAGMA user_version = 6");
    });
  }
}

/**
 * Runs a table rebuild the way SQLite's documented procedure describes it.
 * Foreign keys go off around the transaction, because the pragma is a no-op
 * inside one. A `foreign_key_check` runs before the commit, so a rebuild that
 * stranded a child row rolls back here rather than failing later.
 */
function rebuildTable(database: DatabaseSync, run: () => void): void {
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    inImmediateTransaction(database, () => {
      run();
      const violations = database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(
          `SQLite migration left ${violations.length} row(s) without their parent`
        );
      }
    });
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

export function openSqliteDatabase(input: {
  filename: string;
  busyTimeoutMs: number;
}): SqliteDatabase {
  const database = new DatabaseSync(input.filename, {
    timeout: input.busyTimeoutMs,
  });
  try {
    database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;"
    );
    migrate(database);
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    read: (run) => attempt(() => run(database)),
    write: (run) =>
      attempt(() => inImmediateTransaction(database, () => run(database))),
    close: () => {
      database.close();
      return Promise.resolve();
    },
  };
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function requiredString(
  row: Record<string, unknown>,
  key: string
): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function optionalString(
  row: Record<string, unknown>,
  key: string
): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function requiredNumber(
  row: Record<string, unknown>,
  key: string
): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function optionalNumber(
  row: Record<string, unknown>,
  key: string
): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function requiredBoolean(
  row: Record<string, unknown>,
  key: string
): boolean {
  const value = requiredNumber(row, key);
  if (value !== 0 && value !== 1) throw new Error(`Invalid SQLite ${key}`);
  return value === 1;
}

export function optionalBoolean(
  row: Record<string, unknown>,
  key: string
): boolean | null {
  const value = optionalNumber(row, key);
  if (value === null) return null;
  if (value !== 0 && value !== 1) throw new Error(`Invalid SQLite ${key}`);
  return value === 1;
}

export function requiredDate(row: Record<string, unknown>, key: string): Date {
  return new Date(requiredNumber(row, key));
}

export function optionalDate(
  row: Record<string, unknown>,
  key: string
): Date | null {
  const value = optionalNumber(row, key);
  return value === null ? null : new Date(value);
}

function parseJson(row: Record<string, unknown>, key: string): unknown {
  return JSON.parse(requiredString(row, key));
}

export function requiredGraph(
  row: Record<string, unknown>,
  key = "graph"
): SerializedWorkflowGraph {
  const value = parseJson(row, key);
  if (!isSerializedWorkflowGraph(value)) {
    throw new Error(`Invalid SQLite ${key}`);
  }
  return value;
}

/** Reads a `workflow_versions.kind` from any query row that carries one. */
export function requiredVersionKind(
  row: Record<string, unknown>,
  key = "kind"
): WorkflowVersionKind {
  const value = requiredString(row, key);
  const kind = WORKFLOW_VERSION_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) {
    throw new Error(`Invalid SQLite ${key}`);
  }
  return kind;
}

export function optionalJsonValue(
  row: Record<string, unknown>,
  key: string
): JsonValue | null {
  const encoded = optionalString(row, key);
  if (encoded === null) return null;
  const value = readJsonValue(JSON.parse(encoded));
  if (value === null && encoded !== "null") {
    throw new Error(`Invalid SQLite ${key}`);
  }
  return value;
}

export function optionalJsonObject(
  row: Record<string, unknown>,
  key: string
): JsonObject | null {
  const encoded = optionalString(row, key);
  if (encoded === null) return null;
  const value = readJsonObject(JSON.parse(encoded));
  if (value === null) throw new Error(`Invalid SQLite ${key}`);
  return value;
}

export function encodeJson(value: JsonValue | undefined | null): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function encodeGraph(value: SerializedWorkflowGraph): string {
  return JSON.stringify(value);
}
