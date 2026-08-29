import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
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

  it("keeps a draft snapshot out of the published history", async () => {
    const database = await open(await databasePath());
    try {
      const result = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "digest",
            eventSubscriptions: [],
          });
          const snapshot = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_snapshot",
            graph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });

          // The same graph under the same catalog is one row however many
          // runs ask for it; the proposed id is dropped in favour of the hit.
          const again = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_snapshot_2",
            graph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });

          // A run pins the reused row, so the release must keep it; a row
          // nothing names goes.
          const executions = yield* ExecutionRepo;
          yield* executions.insertTerminal({
            workflowId: "wf_1",
            workflowVersionId: "ver_snapshot",
            startSource: "manual",
            runMode: "test",
            input: {},
            status: "completed",
          });
          const keptPinned =
            yield* workflows.deleteUnreferencedDraftSnapshot("ver_snapshot");
          const loose = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_loose",
            graph: createSerializedWorkflowGraph({
              nodes: [],
              edges: [],
              attributes: { note: "a different graph" },
            }),
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });
          const droppedLoose = yield* workflows.deleteUnreferencedDraftSnapshot(
            loose.id
          );

          return {
            snapshot,
            again,
            keptPinned,
            droppedLoose,
            looseAfter: yield* workflows.findVersionById(loose.id),
            history: yield* workflows.listVersionHistoryPage({
              workflowId: "wf_1",
              limit: 10,
            }),
            latest: yield* workflows.findLatestVersion("wf_1"),
            found: yield* workflows.findVersionById("ver_snapshot"),
            published: yield* workflows.findPublishedVersion("wf_1"),
            forRun: yield* workflows.findByIdWithDraftGraphForRun("wf_1"),
          };
        })
      );

      expect(result.snapshot).toMatchObject({
        id: "ver_snapshot",
        version: null,
        kind: "draft_snapshot",
      });
      // The history and the next version number are the publication's, so a
      // snapshot appears in neither; the engine still reads it by id.
      expect(result.history).toMatchObject([{ id: "ver_1", version: 1 }]);
      expect(result.latest).toEqual({ version: 1 });
      expect(result.again.id).toBe("ver_snapshot");
      expect(result.keptPinned).toBe(false);
      expect(result.droppedLoose).toBe(true);
      expect(result.looseAfter).toBeNull();
      expect(result.found?.kind).toBe("draft_snapshot");
      expect(result.published?.id).toBe("ver_1");
      expect(result.forRun).toMatchObject({
        workflow: { id: "wf_1", mode: "live", isPaused: false },
        draftGraph: emptyGraph,
      });
    } finally {
      await database.close();
    }
  });

  // SQLite cannot drop a NOT NULL, so step 5 rebuilds workflow_versions. Two
  // tables carry a foreign key into it: an execution row a rebuild with foreign
  // keys on would cascade away, and a workflow's published_version_id the same
  // rebuild would silently SET NULL, unpublishing every workflow in the file.
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
      // The published pointer survives the DROP TABLE, which with foreign keys
      // on would have SET NULL it and left the workflow unpublished.
      expect(
        inspection
          .prepare("SELECT id, published_version_id FROM workflows")
          .all()
      ).toEqual([{ id: "wf_1", published_version_id: "ver_1" }]);
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 5,
      });
    } finally {
      inspection.close();
    }
  });

  it("persists repository state across app lifetimes", async () => {
    const filename = await databasePath();
    const first = await open(filename);

    await first.run(
      Effect.gen(function* () {
        const apiKeys = yield* ApiKeyRepo;
        const workflows = yield* WorkflowRepo;
        const executions = yield* ExecutionRepo;
        yield* apiKeys.insert({
          name: "Deploy",
          keyHash: "hash",
          keyPrefix: "wfg_test",
        });
        yield* workflows.insert({
          id: "wf_1",
          name: "Appointments",
          graph: emptyGraph,
          eventSubscriptions: [],
        });
        yield* executions.recordAuditEvent({
          workflowId: "wf_1",
          eventType: "run_refused",
          message: "Refused",
          metadata: { createdAt: "host-json-stays-a-string" },
        });
      })
    );
    await first.close();

    const second = await open(filename);
    try {
      const state = await second.run(
        Effect.gen(function* () {
          const apiKeys = yield* ApiKeyRepo;
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          return {
            keys: yield* apiKeys.listNewestFirst,
            workflow: yield* workflows.findById("wf_1"),
            events: yield* executions.listWorkflowEvents("wf_1"),
          };
        })
      );

      expect(state.keys).toMatchObject([
        { name: "Deploy", keyPrefix: "wfg_test" },
      ]);
      expect(state.workflow?.name).toBe("Appointments");
      expect(state.events[0]?.metadata).toEqual({
        createdAt: "host-json-stays-a-string",
      });
    } finally {
      await second.close();
    }
  });

  it("keeps chronological version history per workflow and pages it newest first", async () => {
    const database = await open(await databasePath());
    try {
      const history = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insert({
            id: "wf_2",
            name: "Billing",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          for (const version of [1, 2, 3]) {
            yield* workflows.insertPublishedVersion({
              workflowId: "wf_1",
              versionId: `ver_${version}`,
              version,
              expectedPublishedVersionId:
                version === 1 ? null : `ver_${version - 1}`,
              graph: emptyGraph,
              draftGraph: emptyGraph,
              catalogFingerprint: "catalog",
              graphDigest: "same-graph",
              eventSubscriptions: [],
            });
          }
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_2",
            versionId: "ver_other",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "same-graph",
            eventSubscriptions: [],
          });

          return {
            all: yield* workflows.listVersionHistoryPage({
              workflowId: "wf_1",
              limit: 3,
            }),
            afterThree: yield* workflows.listVersionHistoryPage({
              workflowId: "wf_1",
              limit: 1,
              cursor: { version: 3 },
            }),
            other: yield* workflows.listVersionHistoryPage({
              workflowId: "wf_2",
              limit: 3,
            }),
          };
        })
      );

      expect(history.all.map((version) => version.version)).toEqual([3, 2, 1]);
      expect(history.all.filter((version) => version.isCurrent)).toMatchObject([
        { id: "ver_3", version: 3 },
      ]);
      // The repository returns the one extra row needed to prove a next cursor.
      expect(history.afterThree.map((version) => version.version)).toEqual([
        2, 1,
      ]);
      expect(history.other).toMatchObject([{ id: "ver_other", version: 1 }]);
    } finally {
      await database.close();
    }
  });

  it("rolls back a failed version publish with its subscription rewrite", async () => {
    const database = await open(await databasePath());
    try {
      await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          return yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
        })
      );

      await expect(
        database.run(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            return yield* workflows.insertPublishedVersion({
              workflowId: "wf_1",
              versionId: "ver_failed",
              version: 1,
              expectedPublishedVersionId: null,
              graph: emptyGraph,
              draftGraph: emptyGraph,
              catalogFingerprint: "catalog",
              graphDigest: "graph",
              eventSubscriptions: [
                {
                  workflowId: "wf_1",
                  eventName: "appointment/created",
                  role: "start",
                  correlationPath: null,
                },
                {
                  workflowId: "wf_1",
                  eventName: "appointment/created",
                  role: "start",
                  correlationPath: null,
                },
              ],
            });
          })
        )
      ).rejects.toBeDefined();

      const state = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          return {
            version: yield* workflows.findVersionById("ver_failed"),
            workflow: yield* workflows.findById("wf_1"),
          };
        })
      );
      expect(state.version).toBeNull();
      expect(state.workflow?.publishedVersionId).toBeNull();
    } finally {
      await database.close();
    }
  });

  it("serializes first-wins starts and makes delivery retries idempotent", async () => {
    const filename = await databasePath();
    const database = await open(filename);
    const otherConnection = await open(filename);
    try {
      await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "graph",
            eventSubscriptions: [],
          });
        })
      );

      const start = (
        connection: Awaited<ReturnType<typeof open>>,
        deliveryId: string
      ) =>
        connection.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.startForEntity({
              execution: {
                workflowId: "wf_1",
                workflowVersionId: "ver_1",
                startSource: "event",
                runMode: "live",
                entityValue: "appointment_1",
                deliveryId,
                input: {},
              },
              concurrency: "first-wins",
              supersededReason: "newer start",
            });
          })
        );

      const [first, second] = await Promise.all([
        start(database, "delivery_1"),
        start(otherConnection, "delivery_2"),
      ]);
      expect([first.status, second.status].toSorted()).toEqual([
        "refused",
        "started",
      ]);

      const started = first.status === "started" ? first : second;
      const retry = await start(
        otherConnection,
        first.status === "started" ? "delivery_1" : "delivery_2"
      );
      expect(retry.status).toBe("started");
      if (started.status === "started" && retry.status === "started") {
        expect(retry.execution.id).toBe(started.execution.id);
      }
    } finally {
      await otherConnection.close();
      await database.close();
    }
  });

  it("fences concurrent wait claims", async () => {
    const filename = await databasePath();
    const database = await open(filename);
    const otherConnection = await open(filename);
    try {
      const waitStateId = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "graph",
            eventSubscriptions: [],
          });
          const started = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (started.status !== "started") throw new Error("start refused");
          const wait = yield* executions.startWait({
            executionId: started.execution.id,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "node_1",
            nodeName: "Approval",
            waitType: "event",
            resumeToken: "resume_1",
          });
          if (!wait) throw new Error("wait refused");
          return wait.waitStateId;
        })
      );

      const claim = (connection: Awaited<ReturnType<typeof open>>) =>
        connection.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            return yield* executions.claimWaitingStateById(waitStateId);
          })
        );
      const claims = await Promise.all([
        claim(database),
        claim(otherConnection),
      ]);
      expect(claims.filter((value) => value !== null)).toHaveLength(1);
    } finally {
      await otherConnection.close();
      await database.close();
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

  it("enforces workflow-name and workflow-run uniqueness in SQLite", async () => {
    const database = await open(await databasePath());
    try {
      await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insert({
            id: "wf_2",
            name: "Billing",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "graph",
            eventSubscriptions: [],
          });
        })
      );

      await expect(
        database.run(
          Effect.gen(function* () {
            const workflows = yield* WorkflowRepo;
            return yield* workflows.update({
              workflowId: "wf_2",
              updates: {
                name: "appointments",
                updatedAt: new Date(),
              },
              eventSubscriptions: "unchanged",
            });
          })
        )
      ).rejects.toBeDefined();

      const executionIds = await database.run(
        Effect.gen(function* () {
          const executions = yield* ExecutionRepo;
          const first = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          const second = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "manual",
              runMode: "live",
              input: {},
            },
            concurrency: "unlimited",
            supersededReason: "newer start",
          });
          if (first.status !== "started" || second.status !== "started") {
            throw new Error("Unlimited start was refused");
          }
          yield* executions.markEnqueued({
            executionId: first.execution.id,
            runId: "run_1",
          });
          return [first.execution.id, second.execution.id];
        })
      );

      await expect(
        database.run(
          Effect.gen(function* () {
            const executions = yield* ExecutionRepo;
            yield* executions.markEnqueued({
              executionId: executionIds[1],
              runId: "run_1",
            });
          })
        )
      ).rejects.toBeDefined();
    } finally {
      await database.close();
    }
  });

  it("implements the execution, log, wait, and audit repository contracts", async () => {
    const database = await open(await databasePath());
    try {
      const result = await database.run(
        Effect.gen(function* () {
          const workflows = yield* WorkflowRepo;
          const executions = yield* ExecutionRepo;
          yield* workflows.insert({
            id: "wf_1",
            name: "Appointments",
            graph: emptyGraph,
            eventSubscriptions: [],
          });
          yield* workflows.insertPublishedVersion({
            workflowId: "wf_1",
            versionId: "ver_1",
            version: 1,
            expectedPublishedVersionId: null,
            graph: emptyGraph,
            draftGraph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "graph",
            eventSubscriptions: [],
          });
          const start = yield* executions.startForEntity({
            execution: {
              workflowId: "wf_1",
              workflowVersionId: "ver_1",
              startSource: "event",
              startEventName: "appointment/created",
              entityValue: "appointment_1",
              deliveryId: "delivery_1",
              runMode: "live",
              input: { appointmentId: "appointment_1" },
            },
            concurrency: "first-wins",
            supersededReason: "newer start",
          });
          if (start.status !== "started") throw new Error("Start was refused");
          const executionId = start.execution.id;
          yield* executions.markEnqueued({ executionId, runId: "run_1" });

          const successfulLog = yield* executions.openNodeLog({
            executionId,
            nodeId: "node_1",
            nodeName: "Create task",
            nodeType: "action",
            input: { title: "Call patient" },
          });
          yield* executions.closeNodeLog({
            logId: successfulLog,
            status: "success",
            output: { taskId: "task_1" },
            durationMs: 12,
          });
          yield* executions.openNodeLog({
            executionId,
            nodeId: "node_2",
            nodeName: "Notify",
            nodeType: "action",
          });

          const wait = yield* executions.startWait({
            executionId,
            workflowId: "wf_1",
            runId: "run_1",
            nodeId: "wait_1",
            nodeName: "Wait for approval",
            waitType: "event",
            resumeToken: "resume_1",
            subscribedEvents: ["appointment/approved"],
            metadata: { expression: "true" },
          });
          if (!wait) throw new Error("Wait was refused");
          const waitsForEvent = yield* executions.listWaitsForEvent({
            workflowId: "wf_1",
            eventName: "appointment/approved",
            runMode: "live",
            limit: 10,
          });
          const subscribers = yield* workflows.listEventSubscribers(
            "appointment/approved"
          );
          const firstClaim =
            yield* executions.claimWaitingStateByToken("resume_1");
          if (!firstClaim) throw new Error("Wait claim was refused");
          const released = yield* executions.releaseWaitingStateClaim({
            waitStateId: wait.waitStateId,
            claimedAt: firstClaim.claimedAt,
          });
          const secondClaim = yield* executions.claimWaitingStateById(
            wait.waitStateId
          );
          if (!secondClaim) throw new Error("Released wait was not claimable");
          const settled = yield* executions.settleWaitingStateClaim({
            waitStateId: wait.waitStateId,
            claimedAt: secondClaim.claimedAt,
          });
          yield* executions.markRunning(executionId);

          const cancelled = yield* executions.requestCancelForEntity({
            workflowId: "wf_1",
            entityValue: "appointment_1",
            runMode: "live",
            eventName: "appointment/cancelled",
            payload: { reason: "host request" },
          });
          const pendingCancel =
            yield* executions.findPendingCancel(executionId);
          yield* executions.cancelOpenNodeLogs(executionId);
          yield* executions.recordAuditEvent({
            workflowId: "wf_1",
            executionId,
            eventType: "run_completed",
            message: "Completed",
          });
          const finished = yield* executions.finishRun({
            executionId,
            status: "completed",
            output: { ok: true },
          });

          const snapshot = {
            executionId,
            waitsForEvent,
            subscribers,
            released,
            settled,
            cancelled,
            pendingCancel,
            finished,
            summary: yield* executions.findSummaryById(executionId),
            status: yield* executions.findStatusById(executionId),
            page: yield* executions.listPage({ limit: 10 }),
            logs: yield* executions.listLogs(executionId),
            outputs: yield* executions.readNodeOutputs(executionId),
            events: yield* executions.listEvents(executionId),
          };
          const deleted = yield* executions.deleteAllForWorkflow("wf_1");
          return {
            ...snapshot,
            deleted,
            existsAfterDelete: yield* executions.existsById(executionId),
          };
        })
      );

      expect(result.waitsForEvent).toHaveLength(1);
      expect(result.subscribers).toMatchObject([
        { id: "wf_1", roles: ["wait"] },
      ]);
      expect(result.released).toBe(true);
      expect(result.settled).toBe(true);
      expect(result.cancelled).toEqual([result.executionId]);
      expect(result.pendingCancel).toEqual({
        eventName: "appointment/cancelled",
        payload: { reason: "host request" },
      });
      expect(result.finished).toBe(true);
      expect(result.summary).toMatchObject({
        status: "completed",
        output: { ok: true },
      });
      expect(result.status).toEqual({
        id: result.executionId,
        status: "completed",
      });
      expect(result.page).toMatchObject([
        { workflowName: "Appointments", workflowIsPaused: false },
      ]);
      expect(result.logs.map((log) => log.status).toSorted()).toEqual([
        "cancelled",
        "success",
      ]);
      expect(result.outputs).toEqual({ node_1: { taskId: "task_1" } });
      expect(result.events).toMatchObject([{ message: "Completed" }]);
      expect(result.deleted).toBe(1);
      expect(result.existsAfterDelete).toBe(false);
    } finally {
      await database.close();
    }
  });
});
