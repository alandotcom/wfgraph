/**
 * The repository contract both persistence backends answer, written once.
 *
 * A backend passes a harness that mints an isolated, migrated database per case;
 * the suite opens connections on it and drops it afterwards. Two connections on
 * one database is what the concurrency cases race, so a harness hands out a
 * database rather than a path or a single handle.
 *
 * Cases that reach past the repositories into one engine's own storage belong in
 * that backend's own file, not here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Effect, type ManagedRuntime } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { WfGraphRepositories } from "#src/backend/runtime";

const emptyGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });

/**
 * The one key every backend seals with, so a config round-trip means the same
 * thing on each side.
 */
export const conformanceCipher = createIntegrationCipher({
  key: "c".repeat(64),
});

/** One open connection: the four repositories on a runtime of its own. */
export type ConformanceConnection = {
  readonly run: ManagedRuntime.ManagedRuntime<
    WfGraphRepositories,
    never
  >["runPromise"];
  readonly close: () => Promise<void>;
};

/** One isolated database, which a case may open more than one connection on. */
export type ConformanceDatabase = {
  readonly open: () => Promise<ConformanceConnection>;
  readonly drop: () => Promise<void>;
};

export type PersistenceConformanceHarness = {
  /** Names the run, as in "native SQLite" or "PostgreSQL". */
  readonly backend: string;
  /** A fresh, empty, migrated database the calling case owns. */
  readonly createDatabase: () => Promise<ConformanceDatabase>;
};

export function describePersistenceConformance(
  harness: PersistenceConformanceHarness
): void {
  const databases: ConformanceDatabase[] = [];
  const connections: ConformanceConnection[] = [];

  // Connections go back before the databases they are checked out of, since a
  // backend that drops a schema cannot do it while a pool still holds it.
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((one) => one.close()));
    await Promise.all(databases.splice(0).map((one) => one.drop()));
  });

  async function openDatabase(): Promise<ConformanceDatabase> {
    const database = await harness.createDatabase();
    databases.push(database);
    return {
      open: async () => {
        const connection = await database.open();
        // Closed once however often it is asked, because a case testing what
        // survives a restart hands its own connection back mid-test and the
        // sweep below would otherwise close an already-closed handle.
        let closed = false;
        const registered: ConformanceConnection = {
          run: connection.run,
          close: async () => {
            if (closed) {
              return;
            }
            closed = true;
            await connection.close();
          },
        };
        connections.push(registered);
        return registered;
      },
      drop: database.drop,
    };
  }

  /** A fresh database and the one connection most cases need. */
  async function openConnection(): Promise<ConformanceConnection> {
    const database = await openDatabase();
    return database.open();
  }

  describe(`${harness.backend} persistence conformance`, () => {
    it("keeps a draft snapshot out of the published history", async () => {
      const database = await openConnection();
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

          // No run references the first row yet, so it stays private to the
          // request that inserted it and this freeze mints a row of its own.
          const unreferenced = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_snapshot_2",
            graph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });

          const executions = yield* ExecutionRepo;
          yield* executions.insertTerminal({
            workflowId: "wf_1",
            workflowVersionId: "ver_snapshot",
            startSource: "manual",
            runMode: "test",
            input: {},
            status: "completed",
          });

          // A run now references the first row, which puts it beyond the
          // release. The same graph under the same catalog therefore reuses it,
          // and the proposed id gives way to that row's id.
          const reused = yield* workflows.freezeDraftSnapshot({
            workflowId: "wf_1",
            versionId: "ver_snapshot_3",
            graph: emptyGraph,
            catalogFingerprint: "catalog",
            graphDigest: "draft-digest",
          });

          // A run pins the reused row, so the release must keep it. A row no
          // run references is deleted.
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
            unreferenced,
            reused,
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
      // The history and the next version number cover published rows only, so
      // a snapshot appears in neither. The engine still reads it by id.
      expect(result.history).toMatchObject([{ id: "ver_1", version: 1 }]);
      expect(result.latest).toEqual({ version: 1 });
      expect(result.unreferenced.id).toBe("ver_snapshot_2");
      expect(result.reused.id).toBe("ver_snapshot");
      expect(result.keptPinned).toBe(false);
      expect(result.droppedLoose).toBe(true);
      expect(result.looseAfter).toBeNull();
      expect(result.found?.kind).toBe("draft_snapshot");
      expect(result.published?.id).toBe("ver_1");
      expect(result.forRun).toMatchObject({
        workflow: { id: "wf_1", mode: "live", isPaused: false },
        draftGraph: emptyGraph,
      });
    });

    it("persists repository state across app lifetimes", async () => {
      const store = await openDatabase();
      const first = await store.open();

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

      const second = await store.open();
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
    });

    it("keeps chronological version history per workflow and pages it newest first", async () => {
      const database = await openConnection();
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
    });

    it("rolls back a failed version publish with its subscription rewrite", async () => {
      const database = await openConnection();
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
    });

    it("serializes first-wins starts and makes delivery retries idempotent", async () => {
      const store = await openDatabase();
      const database = await store.open();
      const otherConnection = await store.open();
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

      const start = (connection: ConformanceConnection, deliveryId: string) =>
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
    });

    it("fences concurrent wait claims", async () => {
      const store = await openDatabase();
      const database = await store.open();
      const otherConnection = await store.open();
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

      const claim = (connection: ConformanceConnection) =>
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
    });

    it("enforces workflow-name and workflow-run uniqueness", async () => {
      const database = await openConnection();
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
    });

    it("implements the execution, log, wait, and audit repository contracts", async () => {
      const database = await openConnection();
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
    });

    it("inserts an integration under a caller-reserved id", async () => {
      const database = await openConnection();
      const inserted = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return yield* integrations.insertWithId({
            id: "int_reserved",
            name: "Reserved",
            type: "linear",
            config: { apiKey: "secret" },
          });
        })
      );

      expect(inserted).toMatchObject({
        id: "int_reserved",
        name: "Reserved",
        type: "linear",
        config: { apiKey: "secret" },
      });
    });

    it("implements the integration repository contract", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const inserted = yield* integrations.insert({
            name: "Primary",
            type: "linear",
            config: { apiKey: "secret" },
          });
          const updated = yield* integrations.update(inserted.id, {
            name: "Updated",
            config: { apiKey: "new-secret" },
            expectedRevision: inserted.configRevision,
          });
          return {
            inserted,
            updated,
            found: yield* integrations.findById(inserted.id),
            types: yield* integrations.typesByIds([inserted.id, "missing"]),
            listed: yield* integrations.listByType("linear"),
            deleteClaim: yield* integrations.claimRefresh({
              integrationId: inserted.id,
              claimId: "delete-claim",
              expectedRevision: 1,
            }),
            deleted: yield* integrations.deleteOwnedRefreshClaim({
              integrationId: inserted.id,
              claimId: "delete-claim",
              expectedRevision: 1,
            }),
            afterDelete: yield* integrations.findById(inserted.id),
          };
        })
      );

      expect(result.inserted.config).toEqual({ apiKey: "secret" });
      expect(result.updated).toMatchObject({
        status: "updated",
        integration: {
          name: "Updated",
          config: { apiKey: "new-secret" },
          configRevision: 1,
        },
      });
      expect(result.found?.config).toEqual({ apiKey: "new-secret" });
      expect(result.types).toEqual({ [result.inserted.id]: "linear" });
      expect(result.listed).toHaveLength(1);
      expect(result.deleteClaim).toEqual({ status: "acquired" });
      expect(result.deleted).toEqual({ status: "deleted" });
      expect(result.afterDelete).toBeNull();
    });

    it("does not delete a newer refresh owner when a stale claim is cleaned up", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "Refreshable",
            type: "linear",
            config: { accessToken: "original" },
          });
          const firstClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "old_claim",
            expectedRevision: 0,
          });
          const firstCompletion = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "old_claim",
            expectedRevision: 0,
            config: { accessToken: "first" },
          });
          const secondClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "new_claim",
            expectedRevision: 1,
          });
          const staleDelete = yield* integrations.deleteOwnedRefreshClaim({
            integrationId: integration.id,
            claimId: "old_claim",
            expectedRevision: 0,
          });
          return {
            firstClaim,
            firstCompletion,
            secondClaim,
            staleDelete,
            integration: yield* integrations.findById(integration.id),
          };
        })
      );

      expect(result.firstClaim).toEqual({ status: "acquired" });
      expect(result.firstCompletion).toBe(true);
      expect(result.secondClaim).toEqual({ status: "acquired" });
      expect(result.staleDelete).toEqual({ status: "no_longer_owned" });
      expect(result.integration).toMatchObject({
        refreshState: "refreshing",
        refreshClaimId: "new_claim",
        configRevision: 1,
      });
    });

    it("claims OAuth attempts once, records durable outcomes, and enforces browser binding", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "OAuth connection",
            type: "linear",
            config: {},
          });
          const refreshClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "reconnect_state",
            expectedRevision: integration.configRevision,
          });
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "reconnect_state",
            integrationId: integration.id,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              kind: "reconnect",
              redirectUri: "https://example.test/oauth/callback",
              configRevision: 0,
              codeVerifier: "valid_verifier",
            },
          });
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "wrong_browser_state",
            integrationId: integration.id,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              kind: "reconnect",
              redirectUri: "https://example.test/oauth/callback",
              configRevision: 0,
            },
          });
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "create_state",
            integrationId: null,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              kind: "create",
              integrationId: "int_reserved",
              name: "New OAuth connection",
              type: "linear",
              config: { MANUAL_TOKEN: "manual" },
              configRevision: 0,
              redirectUri: "https://example.test/oauth/callback",
              codeVerifier: "create_verifier",
            },
          });

          return {
            integrationId: integration.id,
            refreshClaim,
            reconnect: yield* integrations.claimOAuthAuthorizationAttempt({
              stateHash: "reconnect_state",
              browserBindingHash: "browser_hash",
              expiresAt: new Date("2099-01-01T00:10:00Z"),
            }),
            reconnectReplay: yield* integrations.claimOAuthAuthorizationAttempt(
              {
                stateHash: "reconnect_state",
                browserBindingHash: "browser_hash",
                expiresAt: new Date("2099-01-01T00:10:00Z"),
              }
            ),
            wrongBrowser: yield* integrations.claimOAuthAuthorizationAttempt({
              stateHash: "wrong_browser_state",
              browserBindingHash: "other_browser",
              expiresAt: new Date("2099-01-01T00:10:00Z"),
            }),
            wrongBrowserStatus:
              yield* integrations.readOAuthAuthorizationAttemptStatus({
                stateHash: "wrong_browser_state",
                browserBindingHash: "browser_hash",
              }),
            wrongBrowserBinding:
              yield* integrations.readOAuthAuthorizationAttemptStatus({
                stateHash: "wrong_browser_state",
                browserBindingHash: "other_browser",
              }),
            create: yield* integrations.claimOAuthAuthorizationAttempt({
              stateHash: "create_state",
              browserBindingHash: "browser_hash",
              expiresAt: new Date("2099-01-01T00:10:00Z"),
            }),
          };
        })
      );

      expect(result.refreshClaim).toEqual({ status: "acquired" });
      expect(result.reconnect).toEqual({
        integrationId: expect.any(String),
        payload: {
          kind: "reconnect",
          redirectUri: "https://example.test/oauth/callback",
          configRevision: 0,
          codeVerifier: "valid_verifier",
        },
      });
      expect(result.reconnectReplay).toBeNull();
      expect(result.wrongBrowser).toBeNull();
      expect(result.wrongBrowserStatus).toEqual({ status: "failed" });
      expect(result.wrongBrowserBinding).toBeNull();
      expect(result.create).toEqual({
        integrationId: null,
        payload: {
          kind: "create",
          integrationId: "int_reserved",
          name: "New OAuth connection",
          type: "linear",
          config: { MANUAL_TOKEN: "manual" },
          configRevision: 0,
          redirectUri: "https://example.test/oauth/callback",
          codeVerifier: "create_verifier",
        },
      });

      const completed = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return {
            staleReconnect: yield* integrations.completeOAuthReconnectAttempt({
              stateHash: "reconnect_state",
              integrationId: result.reconnect?.integrationId ?? "missing",
              expectedRevision: 1,
              config: { accessToken: "stale" },
              expiresAt: new Date("2099-01-01T00:20:00Z"),
            }),
            reconnect: yield* integrations.completeOAuthReconnectAttempt({
              stateHash: "reconnect_state",
              integrationId: result.reconnect?.integrationId ?? "missing",
              expectedRevision: 0,
              config: { accessToken: "reconnected" },
              expiresAt: new Date("2099-01-01T00:20:00Z"),
            }),
            create: yield* integrations.completeOAuthCreateAttempt({
              stateHash: "create_state",
              integrationId: "int_reserved",
              name: "New OAuth connection",
              type: "linear",
              config: { accessToken: "created" },
              expiresAt: new Date("2099-01-01T00:20:00Z"),
            }),
            reconnectStatus:
              yield* integrations.readOAuthAuthorizationAttemptStatus({
                stateHash: "reconnect_state",
                browserBindingHash: "browser_hash",
              }),
            createStatus:
              yield* integrations.readOAuthAuthorizationAttemptStatus({
                stateHash: "create_state",
                browserBindingHash: "browser_hash",
              }),
            reconnectIntegration: yield* integrations.findById(
              result.integrationId
            ),
            createIntegration: yield* integrations.findById("int_reserved"),
          };
        })
      );

      expect(completed).toMatchObject({
        staleReconnect: false,
        reconnect: true,
        create: true,
        reconnectStatus: {
          status: "succeeded",
          integrationId: result.integrationId,
        },
        createStatus: { status: "succeeded", integrationId: "int_reserved" },
        reconnectIntegration: { config: { accessToken: "reconnected" } },
        createIntegration: { config: { accessToken: "created" } },
      });
    });

    it("fails processing attempts and retains terminal status until expiry", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "failed_state",
            integrationId: null,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              kind: "create",
              integrationId: "int_failed",
              name: "Failed OAuth connection",
              type: "linear",
              config: {},
              configRevision: 0,
              redirectUri: "https://example.test/oauth/callback",
            },
          });
          const claimed = yield* integrations.claimOAuthAuthorizationAttempt({
            stateHash: "failed_state",
            browserBindingHash: "browser_hash",
            expiresAt: new Date("2099-01-01T00:10:00Z"),
          });
          const failed = yield* integrations.failOAuthAuthorizationAttempt({
            stateHash: "failed_state",
            expiresAt: new Date("2099-01-01T00:20:00Z"),
          });
          return {
            claimed,
            failed,
            status: yield* integrations.readOAuthAuthorizationAttemptStatus({
              stateHash: "failed_state",
              browserBindingHash: "browser_hash",
            }),
            replay: yield* integrations.claimOAuthAuthorizationAttempt({
              stateHash: "failed_state",
              browserBindingHash: "browser_hash",
              expiresAt: new Date("2099-01-01T00:30:00Z"),
            }),
          };
        })
      );

      expect(result.claimed).toMatchObject({ integrationId: null });
      expect(result.failed).toBe(true);
      expect(result.status).toEqual({ status: "failed" });
      expect(result.replay).toBeNull();
    });

    it("serializes competing refresh claims across connections", async () => {
      const store = await openDatabase();
      const database = await store.open();
      const otherConnection = await store.open();
      const integration = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return yield* integrations.insert({
            name: "Refreshable",
            type: "linear",
            config: {},
          });
        })
      );
      const claim = (connection: ConformanceConnection, claimId: string) =>
        connection.run(
          Effect.gen(function* () {
            const integrations = yield* IntegrationRepo;
            return yield* integrations.claimRefresh({
              integrationId: integration.id,
              claimId,
              expectedRevision: integration.configRevision,
            });
          })
        );

      const claims = await Promise.all([
        claim(database, "claim_1"),
        claim(otherConnection, "claim_2"),
      ]);
      const stored = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return yield* integrations.findById(integration.id);
        })
      );

      expect(claims.map((outcome) => outcome.status).toSorted()).toEqual([
        "acquired",
        "lost",
      ]);
      expect(stored).toMatchObject({
        refreshState: "refreshing",
        refreshClaimId: claims[0].status === "acquired" ? "claim_1" : "claim_2",
        refreshClaimedAt: expect.any(Date),
      });
    });

    it("fences refresh completion, release, and reauthorization transitions", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "Refreshable",
            type: "linear",
            config: { accessToken: "old" },
          });
          const acquired = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: 0,
          });
          const competing = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_2",
            expectedRevision: 0,
          });
          const staleCompletion = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "claim_2",
            expectedRevision: 0,
            config: { accessToken: "stale" },
          });
          const completed = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: 0,
            config: { accessToken: "new" },
          });
          const afterCompletion = yield* integrations.findById(integration.id);

          yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_3",
            expectedRevision: 1,
          });
          const staleRelease = yield* integrations.releaseRefreshClaim({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: 1,
          });
          const staleReauthorization =
            yield* integrations.markReauthorizationRequired({
              integrationId: integration.id,
              claimId: "claim_1",
              expectedRevision: 1,
            });
          const released = yield* integrations.releaseRefreshClaim({
            integrationId: integration.id,
            claimId: "claim_3",
            expectedRevision: 1,
          });

          yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_4",
            expectedRevision: 1,
          });
          const reauthorization =
            yield* integrations.markReauthorizationRequired({
              integrationId: integration.id,
              claimId: "claim_4",
              expectedRevision: 1,
            });
          const afterReauthorization = yield* integrations.findById(
            integration.id
          );
          const reconnectClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "reconnect_claim",
            expectedRevision: 1,
          });
          const reconnected = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "reconnect_claim",
            expectedRevision: 1,
            config: { accessToken: "reconnected" },
          });
          const afterReconnect = yield* integrations.findById(integration.id);
          const missing = yield* integrations.claimRefresh({
            integrationId: "missing",
            claimId: "claim_5",
            expectedRevision: 0,
          });

          return {
            acquired,
            competing,
            staleCompletion,
            completed,
            afterCompletion,
            staleRelease,
            staleReauthorization,
            released,
            reauthorization,
            afterReauthorization,
            reconnectClaim,
            reconnected,
            afterReconnect,
            missing,
          };
        })
      );

      expect(result.acquired).toEqual({ status: "acquired" });
      expect(result.competing).toEqual({ status: "lost" });
      expect(result.staleCompletion).toBe(false);
      expect(result.completed).toBe(true);
      expect(result.afterCompletion).toMatchObject({
        config: { accessToken: "new" },
        configRevision: 1,
        refreshState: "idle",
        refreshClaimId: null,
        refreshClaimedAt: null,
      });
      expect(result.staleRelease).toBe(false);
      expect(result.staleReauthorization).toEqual({
        status: "no_longer_owned",
      });
      expect(result.released).toBe(true);
      expect(result.reauthorization).toEqual({ status: "transitioned" });
      expect(result.afterReauthorization).toMatchObject({
        refreshState: "reauthorization_required",
        refreshClaimId: null,
        refreshClaimedAt: null,
      });
      expect(result.reconnectClaim).toEqual({ status: "acquired" });
      expect(result.reconnected).toBe(true);
      expect(result.afterReconnect).toMatchObject({
        config: { accessToken: "reconnected" },
        configRevision: 2,
        refreshState: "idle",
        refreshClaimId: null,
        refreshClaimedAt: null,
      });
      expect(result.missing).toEqual({ status: "not_found" });
    });

    it("keeps an owned refresh authoritative over a racing manual config update", async () => {
      const database = await openConnection();
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "Refreshable",
            type: "linear",
            config: { accessToken: "old" },
          });
          yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: integration.configRevision,
          });
          const manual = yield* integrations.update(integration.id, {
            config: { accessToken: "manual" },
            expectedRevision: integration.configRevision,
          });
          const renamed = yield* integrations.update(integration.id, {
            name: "Renamed while refreshing",
          });
          const completed = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "claim_1",
            expectedRevision: integration.configRevision,
            config: { accessToken: "refreshed" },
          });
          const afterRefresh = yield* integrations.findById(integration.id);
          if (!afterRefresh) throw new Error("Integration disappeared");
          const reconnectClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "reconnect_claim",
            expectedRevision: afterRefresh.configRevision,
          });
          const reconnected = yield* integrations.completeRefresh({
            integrationId: integration.id,
            claimId: "reconnect_claim",
            expectedRevision: afterRefresh.configRevision,
            config: { accessToken: "reconnected" },
          });
          const staleClaim = yield* integrations.claimRefresh({
            integrationId: integration.id,
            claimId: "stale_reader",
            expectedRevision: afterRefresh.configRevision,
          });

          return {
            manual,
            renamed,
            completed,
            afterRefresh,
            reconnectClaim,
            reconnected,
            staleClaim,
            stored: yield* integrations.findById(integration.id),
          };
        })
      );

      expect(result.manual).toEqual({ status: "conflict" });
      expect(result.renamed).toMatchObject({
        status: "updated",
        integration: { name: "Renamed while refreshing" },
      });
      expect(result.completed).toBe(true);
      expect(result.afterRefresh).toMatchObject({
        config: { accessToken: "refreshed" },
        configRevision: 1,
      });
      expect(result.reconnectClaim).toEqual({ status: "acquired" });
      expect(result.reconnected).toBe(true);
      expect(result.staleClaim).toEqual({ status: "lost" });
      expect(result.stored).toMatchObject({
        config: { accessToken: "reconnected" },
        configRevision: 2,
        refreshState: "idle",
      });
    });
  });
}
