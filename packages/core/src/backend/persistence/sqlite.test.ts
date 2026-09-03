import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import { Effect, ManagedRuntime } from "effect";
import { sql } from "drizzle-orm";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  DatabaseError,
  hasDatabaseErrorCode,
} from "#src/backend/lib/effect/database";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import { openSqliteDatabase } from "#src/backend/persistence/sqlite/database";
import { sqliteMigrations } from "#src/backend/persistence/sqlite/generated-migrations";

const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });
const cipher = createIntegrationCipher({ key: "c".repeat(64) });
const directories: string[] = [];

// Frozen final schema produced by the pre-Drizzle migrations through version 6.
// Keep this independent of the current baseline so adoption tests exercise a
// database created by the implementation being replaced.
const LEGACY_SCHEMA_6 = `
  create table workflows (
    id text primary key,
    name text not null collate nocase unique,
    description text,
    graph text not null,
    is_paused integer not null default 0 check (is_paused in (0, 1)),
    mode text not null default 'live' check (mode in ('live', 'test')),
    visibility text not null default 'private' check (visibility in ('private', 'public')),
    published_version_id text,
    created_at integer not null,
    updated_at integer not null,
    foreign key (published_version_id) references workflow_versions(id) on delete set null
  ) strict;

  create table "workflow_versions" (
    id text primary key,
    workflow_id text not null references workflows(id) on delete cascade,
    version integer,
    kind text not null default 'published' check (kind in ('published', 'draft_snapshot')),
    graph text not null,
    catalog_fingerprint text not null,
    graph_digest text not null,
    published_at integer not null,
    unique (workflow_id, version)
  ) strict;

  create table workflow_event_subscriptions (
    workflow_id text not null references workflows(id) on delete cascade,
    event_name text not null,
    role text not null check (role in ('start', 'cancel', 'wait')),
    correlation_path text,
    connection_id text,
    primary key (workflow_id, event_name, role)
  ) strict, without rowid;

  create table workflow_executions (
    id text primary key,
    workflow_id text not null references workflows(id) on delete cascade,
    workflow_version_id text not null references workflow_versions(id) on delete cascade,
    workflow_run_id text unique,
    status text not null check (status in ('pending', 'running', 'waiting', 'completed', 'failed', 'canceled', 'superseded')),
    start_source text check (start_source is null or start_source in ('event', 'manual', 'schedule')),
    delivery_id text,
    enqueued_at integer,
    run_mode text not null default 'live' check (run_mode in ('live', 'test')),
    start_event_name text,
    entity_value text,
    input text check (input is null or json_valid(input)),
    output text check (output is null or json_valid(output)),
    error text,
    started_at integer not null,
    waiting_at integer,
    cancelled_at integer,
    completed_at integer,
    duration text,
    cancel_requested_at integer,
    cancel_event_name text,
    cancel_payload text check (cancel_payload is null or json_valid(cancel_payload)),
    unique (workflow_id, delivery_id)
  ) strict;

  create table workflow_execution_logs (
    id text primary key,
    execution_id text not null references workflow_executions(id) on delete cascade,
    node_id text not null,
    node_name text not null,
    node_type text not null,
    status text not null check (status in ('pending', 'running', 'success', 'error', 'cancelled')),
    input text check (input is null or json_valid(input)),
    output text check (output is null or json_valid(output)),
    error text,
    started_at integer not null,
    completed_at integer,
    duration text,
    timestamp integer not null
  ) strict;

  create table workflow_wait_states (
    id text primary key,
    execution_id text not null references workflow_executions(id) on delete cascade,
    workflow_id text not null references workflows(id) on delete cascade,
    run_id text not null,
    node_id text not null,
    node_name text not null,
    wait_type text not null check (wait_type in ('delay', 'event')),
    status text not null check (status in ('waiting', 'resuming', 'resumed', 'timed_out', 'cancelled')),
    resume_token text unique,
    wait_until integer,
    subscribed_events text not null default '[]' check (json_valid(subscribed_events) and json_type(subscribed_events) = 'array'),
    metadata text check (metadata is null or (json_valid(metadata) and json_type(metadata) = 'object')),
    created_at integer not null,
    resumed_at integer,
    cancelled_at integer
  ) strict;

  create table workflow_execution_events (
    id text primary key,
    workflow_id text not null references workflows(id) on delete cascade,
    execution_id text references workflow_executions(id) on delete cascade,
    event_type text not null,
    message text not null,
    metadata text check (metadata is null or (json_valid(metadata) and json_type(metadata) = 'object')),
    created_at integer not null
  ) strict;

  create table api_keys (
    id text primary key,
    name text,
    key_hash text not null,
    key_prefix text not null,
    created_at integer not null,
    last_used_at integer
  ) strict;

  create table integrations (
    id text primary key,
    name text not null,
    type text not null,
    config text not null,
    is_managed integer default 0 check (is_managed is null or is_managed in (0, 1)),
    created_at integer not null,
    updated_at integer not null,
    refresh_state text not null default 'idle' check (refresh_state in ('idle', 'refreshing', 'reauthorization_required')),
    config_revision integer not null default 0,
    refresh_claim_id text,
    refresh_claimed_at integer
  ) strict;

  create table oauth_authorization_attempts (
    state_hash text primary key,
    integration_id text references integrations(id) on delete cascade,
    expires_at integer not null,
    browser_binding_hash text not null,
    encrypted_payload text not null,
    mode text not null check (mode in ('create', 'reconnect')),
    status text not null check (status in ('pending', 'processing', 'succeeded', 'failed')),
    result_integration_id text,
    created_at integer not null,
    updated_at integer not null
  ) strict;

  create index api_keys_prefix_idx on api_keys(key_prefix);
  create index integrations_type_idx on integrations(type);
  create index subscriptions_event_idx on workflow_event_subscriptions(event_name);
  create index executions_workflow_started_idx on workflow_executions(workflow_id, started_at desc, id desc);
  create index executions_started_idx on workflow_executions(started_at desc, id desc);
  create index executions_entity_idx on workflow_executions(workflow_id, entity_value, run_mode, status);
  create index logs_execution_timestamp_idx on workflow_execution_logs(execution_id, timestamp desc);
  create index waits_execution_status_idx on workflow_wait_states(execution_id, status);
  create index waits_workflow_status_idx on workflow_wait_states(workflow_id, status);
  create index events_execution_created_idx on workflow_execution_events(execution_id, created_at desc);
  create index events_workflow_created_idx on workflow_execution_events(workflow_id, created_at desc);
  create index oauth_attempts_integration_idx on oauth_authorization_attempts(integration_id);
  create index oauth_attempts_expires_at_idx on oauth_authorization_attempts(expires_at);
`;

const LEGACY_SCHEMA_7 = `
  create index executions_workflow_in_flight_version_started_idx
    on workflow_executions(workflow_id, workflow_version_id, started_at)
    where status in ('pending', 'running', 'waiting');
`;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "wfgraph-sqlite-"));
  directories.push(directory);
  return join(directory, "wfgraph.db");
}

async function open(filename: string) {
  const instance = await wfSqlite({ filename }).open(cipher);
  const runtime = ManagedRuntime.make(instance.repositories);
  return {
    run: runtime.runPromise.bind(runtime),
    close: async () => {
      await runtime.dispose();
      await instance.close();
    },
  };
}

async function prepareLegacyDatabase(
  filename: string,
  version: number
): Promise<void> {
  const database = new DatabaseSync(filename);
  try {
    database.exec(LEGACY_SCHEMA_6);
    if (version >= 7) database.exec(LEGACY_SCHEMA_7);
    database.exec(`
      INSERT INTO workflows
        (id, name, graph, is_paused, mode, visibility, created_at, updated_at)
      VALUES ('wf_legacy', 'Legacy', '{"nodes":[],"edges":[]}', 0,
              'live', 'private', 1, 1);
      INSERT INTO workflow_versions
        (id, workflow_id, version, kind, graph, catalog_fingerprint,
         graph_digest, published_at)
      VALUES ('ver_legacy', 'wf_legacy', 1, 'published',
              '{"nodes":[],"edges":[]}', 'catalog', 'digest', 1);
      UPDATE workflows SET published_version_id = 'ver_legacy'
      WHERE id = 'wf_legacy';
      PRAGMA user_version = ${version};
    `);
  } finally {
    database.close();
  }
}

function createMigrationJournal(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE __wfgraph_sqlite_migrations (
      id INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at NUMERIC,
      name TEXT,
      applied_at TEXT
    );
  `);
  const insert = database.prepare(
    `INSERT INTO __wfgraph_sqlite_migrations
         (hash, created_at, name, applied_at)
       VALUES (?, ?, ?, ?)`
  );
  for (const migration of sqliteMigrations) {
    insert.run(
      migration.hash,
      migration.folderMillis,
      migration.name,
      "2026-09-01"
    );
  }
}

describe("native SQLite persistence", () => {
  it("uses an in-memory database when no filename is provided", async () => {
    const instance = await wfSqlite().open(cipher);
    try {
      await using runtime = ManagedRuntime.make(instance.repositories);
      const workflow = await runtime.runPromise(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_memory",
            name: "Ephemeral",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          return yield* workflows.findById("wf_memory");
        })
      );

      expect(instance.description).toEqual({
        backend: "sqlite",
        filename: ":memory:",
      });
      expect(workflow?.name).toBe("Ephemeral");
    } finally {
      await instance.close();
    }
  });

  it("rejects a published version without a version number", async () => {
    const filename = await databasePath();
    const initialized = await open(filename);
    await initialized.close();

    const database = new DatabaseSync(filename);
    try {
      database.exec(`
        INSERT INTO workflows
          (id, name, graph, is_paused, mode, visibility, created_at, updated_at)
        VALUES ('wf_corrupt', 'Corrupt', '{"nodes":[],"edges":[]}', 0,
                'live', 'private', 1, 1);
        INSERT INTO workflow_versions
          (id, workflow_id, version, kind, graph, catalog_fingerprint,
           graph_digest, published_at)
        VALUES ('ver_corrupt', 'wf_corrupt', NULL, 'published',
                '{"nodes":[],"edges":[]}', 'catalog', 'digest', 1);
      `);
    } finally {
      database.close();
    }

    const persistence = await open(filename);
    try {
      const error = await persistence.run(
        Effect.flip(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            return yield* workflows.findLatestVersion("wf_corrupt");
          })
        )
      );

      expect(error).toBeInstanceOf(DatabaseError);
      expect(inspect(error, { depth: null })).toContain(
        "Invalid SQLite published version"
      );
    } finally {
      await persistence.close();
    }
  });

  it("serializes concurrent initialization of a fresh database", async () => {
    const filename = await databasePath();
    const [first, second] = await Promise.all([open(filename), open(filename)]);
    try {
      const inspection = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(
          inspection
            .prepare(
              "select count(*) as total from __wfgraph_sqlite_migrations"
            )
            .get()
        ).toEqual({ total: sqliteMigrations.length });
      } finally {
        inspection.close();
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("creates a fresh normalized schema from the Drizzle migrations", async () => {
    const filename = await databasePath();
    const persistence = await open(filename);
    await persistence.close();

    const database = new DatabaseSync(filename, { readOnly: true });
    try {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        .all()
        .map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "__wfgraph_sqlite_migrations",
          "workflows",
          "workflow_executions",
          "workflow_wait_states",
        ])
      );
      expect(tables).not.toContain("wfgraph_state");
      expect(
        database
          .prepare(
            "SELECT hash, created_at, name FROM __wfgraph_sqlite_migrations ORDER BY id"
          )
          .all()
      ).toEqual(
        sqliteMigrations.map((migration) => ({
          hash: migration.hash,
          created_at: migration.folderMillis,
          name: migration.name,
        }))
      );
      expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
        journal_mode: "wal",
      });
      const applicationTables = database
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             AND name <> '__wfgraph_sqlite_migrations'`
        )
        .all();
      expect(applicationTables).toHaveLength(10);
      for (const table of applicationTables) {
        expect(table.sql).toMatch(/\) STRICT(?:, WITHOUT ROWID)?$/);
      }
      expect(
        applicationTables.find(
          (table) => table.name === "workflow_event_subscriptions"
        )?.sql
      ).toMatch(/\) STRICT, WITHOUT ROWID$/);
      expect(
        database
          .prepare("PRAGMA index_xinfo('executions_workflow_started_idx')")
          .all()
          .filter((column) => column.key === 1)
          .map((column) => ({ name: column.name, desc: column.desc }))
      ).toEqual([
        { name: "workflow_id", desc: 0 },
        { name: "started_at", desc: 1 },
        { name: "id", desc: 1 },
      ]);
      expect(
        database
          .prepare("PRAGMA index_xinfo('events_workflow_type_created_idx')")
          .all()
          .filter((column) => column.key === 1)
          .map((column) => ({ name: column.name, desc: column.desc }))
      ).toEqual([
        { name: "workflow_id", desc: 0 },
        { name: "event_type", desc: 0 },
        { name: "created_at", desc: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it.each([6, 7])(
    "adopts version %i without rewriting its data",
    async (version) => {
      const filename = await databasePath();
      await prepareLegacyDatabase(filename, version);

      const persistence = await open(filename);
      try {
        const workflow = await persistence.run(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            return yield* workflows.findById("wf_legacy");
          })
        );
        expect(workflow).toMatchObject({
          id: "wf_legacy",
          name: "Legacy",
          publishedVersionId: "ver_legacy",
        });
      } finally {
        await persistence.close();
      }

      const database = new DatabaseSync(filename, { readOnly: true });
      try {
        expect(
          database
            .prepare(
              `SELECT name FROM sqlite_master
               WHERE type = 'index'
                 AND name = 'executions_workflow_in_flight_version_started_idx'`
            )
            .get()
        ).toEqual({
          name: "executions_workflow_in_flight_version_started_idx",
        });
        expect(
          database
            .prepare(
              "SELECT count(*) AS total FROM __wfgraph_sqlite_migrations"
            )
            .get()
        ).toEqual({ total: sqliteMigrations.length });
        expect(database.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 0,
        });
      } finally {
        database.close();
      }
    }
  );

  it.each([1, 2, 3, 4, 5])(
    "refuses version %i and explains the required upgrade path",
    async (version) => {
      const filename = await databasePath();
      await prepareLegacyDatabase(filename, version);

      await expect(wfSqlite({ filename }).open(cipher)).rejects.toThrow(
        `schema version ${version}; versions 1-5 must be upgraded with an earlier Workflow Graph release first`
      );
    }
  );

  it("refuses a partial Workflow Graph schema", async () => {
    const filename = await databasePath();
    const database = new DatabaseSync(filename);
    database.exec(`
      CREATE TABLE workflows (id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 6;
    `);
    database.close();

    await expect(wfSqlite({ filename }).open(cipher)).rejects.toThrow(
      "cannot adopt an unrecognized SQLite schema at version 6"
    );
  });

  it("refuses a host table that collides with the migration journal", async () => {
    const filename = await databasePath();
    const database = new DatabaseSync(filename);
    database.exec(
      "CREATE TABLE __wfgraph_sqlite_migrations (id INTEGER PRIMARY KEY)"
    );
    database.close();

    await expect(wfSqlite({ filename }).open(cipher)).rejects.toThrow(
      "migration journal has an unrecognized schema"
    );
  });

  it("refuses an incomplete schema behind a valid migration journal", async () => {
    const filename = await databasePath();
    const database = new DatabaseSync(filename);
    createMigrationJournal(database);
    database.exec("CREATE TABLE workflows (id TEXT PRIMARY KEY) STRICT");
    database.close();

    await expect(wfSqlite({ filename }).open(cipher)).rejects.toThrow(
      "migration journal exists, but its application schema is incomplete"
    );
  });

  it("refuses a migration journal that does not record the baseline", async () => {
    const filename = await databasePath();
    const persistence = await open(filename);
    await persistence.close();

    const database = new DatabaseSync(filename);
    database.exec("DELETE FROM __wfgraph_sqlite_migrations");
    database.close();

    await expect(wfSqlite({ filename }).open(cipher)).rejects.toThrow(
      "migration journal does not contain the shipped baseline"
    );
  });

  it("refuses a migration journal written by a newer release", async () => {
    const filename = await databasePath();
    const persistence = await open(filename);
    await persistence.close();

    const database = new DatabaseSync(filename);
    database
      .prepare(
        `INSERT INTO __wfgraph_sqlite_migrations
           (hash, created_at, name, applied_at)
         VALUES ('future', 9999999999999, 'future', '2026-09-02')`
      )
      .run();
    database.close();

    await expect(wfSqlite({ filename }).open(cipher)).rejects.toThrow(
      "database was migrated by a newer release"
    );
  });

  it("refuses a journaled schema whose physical invariants changed", async () => {
    const filename = await databasePath();
    const persistence = await open(filename);
    await persistence.close();

    const database = new DatabaseSync(filename);
    database.exec("DROP INDEX executions_started_idx");
    database.close();

    await expect(wfSqlite({ filename }).open(cipher)).rejects.toThrow(
      "application schema does not match its migration journal"
    );
  });

  it("keeps bound values out of database failures", async () => {
    const filename = await databasePath();
    const database = await openSqliteDatabase({
      filename,
      busyTimeoutMs: 1_000,
    });
    const sentinel = "payload-that-must-not-be-logged";
    try {
      await Effect.runPromise(
        database.write((executor) =>
          executor.run(
            sql`create table host_unique_values (id text primary key, value text) strict`
          )
        )
      );
      await Effect.runPromise(
        database.write((executor) =>
          executor.run(
            sql`insert into host_unique_values values (${"same"}, ${sentinel})`
          )
        )
      );
      const error = await Effect.runPromise(
        Effect.flip(
          database.write((executor) =>
            executor.run(
              sql`insert into host_unique_values values (${"same"}, ${sentinel})`
            )
          )
        )
      );

      expect(inspect(error, { depth: null })).not.toContain(sentinel);
      expect(hasDatabaseErrorCode(error, "ERR_SQLITE_ERROR")).toBe(true);
    } finally {
      await database.close();
    }
  });

  it("shares a database with tables owned by the host", async () => {
    const filename = await databasePath();
    const database = new DatabaseSync(filename);
    database.exec("CREATE TABLE host_records (id TEXT PRIMARY KEY) STRICT");
    database.close();

    const persistence = await open(filename);
    await persistence.close();

    const inspection = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(
        inspection
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN
               ('host_records', 'workflows', '__wfgraph_sqlite_migrations')
             ORDER BY name`
          )
          .all()
      ).toEqual([
        { name: "__wfgraph_sqlite_migrations" },
        { name: "host_records" },
        { name: "workflows" },
      ]);
    } finally {
      inspection.close();
    }
  });

  it("refuses a lookalike legacy schema with the expected table names", async () => {
    const filename = await databasePath();
    const database = new DatabaseSync(filename);
    for (const table of [
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
    ]) {
      database.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY) STRICT`);
    }
    database.exec("PRAGMA user_version = 7");
    database.close();

    await expect(wfSqlite({ filename }).open(cipher)).rejects.toThrow(
      "cannot adopt an unrecognized SQLite schema at version 7"
    );
  });

  it("refuses a legacy schema whose physical invariants changed", async () => {
    const filename = await databasePath();
    await prepareLegacyDatabase(filename, 7);

    const database = new DatabaseSync(filename);
    database.exec(`
      DROP INDEX executions_workflow_started_idx;
      CREATE INDEX executions_workflow_started_idx
        ON workflow_executions(workflow_id, started_at, id);
    `);
    database.close();

    await expect(wfSqlite({ filename }).open(cipher)).rejects.toThrow(
      "cannot adopt an unrecognized SQLite schema at version 7"
    );
  });

  it("can be closed more than once", async () => {
    const filename = await databasePath();
    const instance = await wfSqlite({ filename }).open(cipher);

    await instance.close();
    await expect(instance.close()).resolves.toBeUndefined();
  });
});
