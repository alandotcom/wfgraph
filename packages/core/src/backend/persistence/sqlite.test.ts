import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { wfSqlite } from "#src/backend/persistence/sqlite";

const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });
const cipher = createIntegrationCipher({ key: "c".repeat(64) });
const directories: string[] = [];

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

describe("native SQLite persistence", () => {
  it("uses an in-memory database when no filename is provided", async () => {
    const instance = await wfSqlite().open(cipher);
    const runtime = ManagedRuntime.make(instance.repositories);
    try {
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
      await runtime.dispose();
      await instance.close();
    }
  });

  // SQLite cannot drop a NOT NULL constraint, so step 5 rebuilds
  // workflow_versions. Two tables carry a foreign key into it. With foreign keys
  // on, the rebuild would cascade every execution row away and set every
  // workflow's published_version_id to NULL, unpublishing every workflow in the
  // file.
  it("rebuilds workflow_versions without dropping what points at it", async () => {
    const filename = await databasePath();
    const versionFour = new DatabaseSync(filename);
    versionFour.exec(`
      PRAGMA foreign_keys = ON;
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
        version INTEGER NOT NULL,
        graph TEXT NOT NULL,
        catalog_fingerprint TEXT NOT NULL,
        graph_digest TEXT NOT NULL,
        published_at INTEGER NOT NULL,
        UNIQUE (workflow_id, version)
      ) STRICT;
      CREATE TABLE workflow_executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE
      ) STRICT;
      INSERT INTO workflows (id, name, graph, created_at, updated_at)
      VALUES ('wf_1', 'Appointments', '{}', 0, 0);
      INSERT INTO workflow_versions
        (id, workflow_id, version, graph, catalog_fingerprint, graph_digest, published_at)
      VALUES ('ver_1', 'wf_1', 1, '{}', 'catalog', 'digest', 0);
      INSERT INTO workflow_executions (id, workflow_id, workflow_version_id)
      VALUES ('exec_1', 'wf_1', 'ver_1');
      UPDATE workflows SET published_version_id = 'ver_1' WHERE id = 'wf_1';
      PRAGMA user_version = 4;
    `);
    versionFour.close();

    const database = await open(filename);
    await database.close();

    const inspection = new DatabaseSync(filename);
    try {
      const columns = inspection
        .prepare("PRAGMA table_info(workflow_versions)")
        .all();
      expect(columns.find((column) => column.name === "version")?.notnull).toBe(
        0
      );
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "kind", notnull: 1 }),
        ])
      );
      expect(
        inspection
          .prepare("SELECT id, version, kind FROM workflow_versions")
          .all()
      ).toEqual([{ id: "ver_1", version: 1, kind: "published" }]);
      expect(
        inspection.prepare("SELECT id FROM workflow_executions").all()
      ).toEqual([{ id: "exec_1" }]);
      // The published pointer survives the DROP TABLE. With foreign keys on,
      // the drop would have set it to NULL and left the workflow unpublished.
      expect(
        inspection
          .prepare("SELECT id, published_version_id FROM workflows")
          .all()
      ).toEqual([{ id: "wf_1", published_version_id: "ver_1" }]);
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 6,
      });
    } finally {
      inspection.close();
    }
  });

  it("uses normalized tables instead of a serialized state row", async () => {
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
      expect(tables).toContain("workflows");
      expect(tables).toContain("workflow_executions");
      expect(tables).toContain("workflow_wait_states");
      expect(tables).not.toContain("wfgraph_state");
    } finally {
      database.close();
    }
  });
});
