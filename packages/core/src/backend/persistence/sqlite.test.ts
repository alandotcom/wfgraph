import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { ApiKeyRepo } from "#src/backend/services/api-keys/repo";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
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

  it("implements the integration repository contract", async () => {
    const database = await open(await databasePath());
    try {
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
            deleted: yield* integrations.deleteById(inserted.id),
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
      expect(result.deleted).toBe(true);
      expect(result.afterDelete).toBeNull();
    } finally {
      await database.close();
    }
  });

  it("consumes OAuth attempts once and enforces expiry and browser binding", async () => {
    const database = await open(await databasePath());
    try {
      const result = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "OAuth connection",
            type: "linear",
            config: {},
          });
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "valid_state",
            integrationId: integration.id,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
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
              redirectUri: "https://example.test/oauth/callback",
              configRevision: 0,
            },
          });
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "expired_state",
            integrationId: integration.id,
            expiresAt: new Date("2000-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              redirectUri: "https://example.test/oauth/callback",
              configRevision: 0,
            },
          });

          return {
            valid: yield* integrations.consumeOAuthAuthorizationAttempt(
              "valid_state",
              "browser_hash"
            ),
            replay: yield* integrations.consumeOAuthAuthorizationAttempt(
              "valid_state",
              "browser_hash"
            ),
            wrongBrowser: yield* integrations.consumeOAuthAuthorizationAttempt(
              "wrong_browser_state",
              "other_browser"
            ),
            wrongBrowserReplay:
              yield* integrations.consumeOAuthAuthorizationAttempt(
                "wrong_browser_state",
                "browser_hash"
              ),
            expired: yield* integrations.consumeOAuthAuthorizationAttempt(
              "expired_state",
              "browser_hash"
            ),
          };
        })
      );

      expect(result).toEqual({
        valid: {
          integrationId: expect.any(String),
          payload: {
            redirectUri: "https://example.test/oauth/callback",
            configRevision: 0,
            codeVerifier: "valid_verifier",
          },
        },
        replay: null,
        wrongBrowser: null,
        wrongBrowserReplay: null,
        expired: null,
      });
    } finally {
      await database.close();
    }
  });

  it("removes abandoned expired OAuth attempts while preserving active attempts", async () => {
    const filename = await databasePath();
    const database = await open(filename);
    await database.run(
      Effect.gen(function* () {
        const integrations = yield* IntegrationRepo;
        const integration = yield* integrations.insert({
          name: "OAuth connection",
          type: "linear",
          config: {},
        });
        yield* integrations.createOAuthAuthorizationAttempt({
          stateHash: "expired_state",
          integrationId: integration.id,
          expiresAt: new Date("2000-01-01T00:00:00Z"),
          browserBindingHash: "browser_hash",
          payload: {
            redirectUri: "https://example.test/oauth/callback",
            configRevision: 0,
          },
        });
        yield* integrations.createOAuthAuthorizationAttempt({
          stateHash: "active_state",
          integrationId: integration.id,
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          browserBindingHash: "browser_hash",
          payload: {
            redirectUri: "https://example.test/oauth/callback",
            configRevision: 0,
          },
        });
      })
    );
    await database.close();

    const inspection = new DatabaseSync(filename);
    try {
      const attempts = inspection
        .prepare(
          "SELECT state_hash FROM oauth_authorization_attempts ORDER BY state_hash"
        )
        .all();
      expect(attempts).toEqual([{ state_hash: "active_state" }]);
    } finally {
      inspection.close();
    }
  });

  it("serializes competing refresh claims across SQLite connections", async () => {
    const filename = await databasePath();
    const database = await open(filename);
    const otherConnection = await open(filename);
    try {
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
      const claim = (
        connection: Awaited<ReturnType<typeof open>>,
        claimId: string
      ) =>
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
    } finally {
      await otherConnection.close();
      await database.close();
    }
  });

  it("fences refresh completion, release, and reauthorization transitions", async () => {
    const database = await open(await databasePath());
    try {
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
      expect(result.staleReauthorization).toBe(false);
      expect(result.released).toBe(true);
      expect(result.reauthorization).toBe(true);
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
    } finally {
      await database.close();
    }
  });

  it("keeps an owned refresh authoritative over a racing manual config update", async () => {
    const database = await open(await databasePath());
    try {
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
    } finally {
      await database.close();
    }
  });

  it("migrates an existing integration row to idle refresh state", async () => {
    const filename = await databasePath();
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE integrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        config TEXT NOT NULL,
        is_managed INTEGER DEFAULT 0 CHECK (is_managed IS NULL OR is_managed IN (0, 1)),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    legacy
      .prepare(
        `INSERT INTO integrations
         (id, name, type, config, is_managed, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        "int_legacy",
        "Legacy",
        "linear",
        cipher.seal({ accessToken: "kept" }),
        Date.parse("2026-01-01T00:00:00Z"),
        Date.parse("2026-01-01T00:00:00Z")
      );
    legacy.close();

    const database = await open(filename);
    try {
      const integration = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return yield* integrations.findById("int_legacy");
        })
      );

      expect(integration).toMatchObject({
        id: "int_legacy",
        config: { accessToken: "kept" },
        configRevision: 0,
        refreshState: "idle",
        refreshClaimId: null,
        refreshClaimedAt: null,
      });
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
