import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import { INTEGRATION_REFRESH_STATES } from "@wfgraph/shared/types/integration";

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

describe("native SQLite integration persistence", () => {
  it("upgrades version 2 OAuth attempts to durable attempt states", async () => {
    const filename = await databasePath();
    const versionTwo = new DatabaseSync(filename);
    versionTwo.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE integrations (id TEXT PRIMARY KEY) STRICT;
      -- Migration step 5 rebuilds workflow_versions, so this fixture includes
      -- the workflow tables a database at that version actually had.
      CREATE TABLE workflows (id TEXT PRIMARY KEY) STRICT;
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
      INSERT INTO integrations (id) VALUES ('int_existing');
      INSERT INTO oauth_authorization_attempts
        (state_hash, integration_id, expires_at, browser_binding_hash, encrypted_payload, created_at)
      VALUES ('state', 'int_existing', 4102444800000, 'binding', 'sealed', 0);
      PRAGMA user_version = 2;
    `);
    versionTwo.close();

    const database = await open(filename);
    await database.close();

    const inspection = new DatabaseSync(filename);
    try {
      const columns = inspection
        .prepare("PRAGMA table_info(oauth_authorization_attempts)")
        .all();
      expect(
        columns.find((column) => column.name === "integration_id")?.notnull
      ).toBe(0);
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "mode", notnull: 1 }),
          expect.objectContaining({ name: "status", notnull: 1 }),
          expect.objectContaining({
            name: "result_integration_id",
            notnull: 0,
          }),
          expect.objectContaining({ name: "updated_at", notnull: 1 }),
        ])
      );
      expect(
        inspection
          .prepare(
            `SELECT state_hash, integration_id, mode, status, result_integration_id,
                    updated_at
             FROM oauth_authorization_attempts`
          )
          .get()
      ).toEqual({
        state_hash: "state",
        integration_id: "int_existing",
        mode: "reconnect",
        status: "pending",
        result_integration_id: null,
        updated_at: 0,
      });
      expect(inspection.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 5,
      });
    } finally {
      inspection.close();
    }
  });

  it("inserts an integration under a caller-reserved id", async () => {
    const database = await open(await databasePath());
    try {
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
    } finally {
      await database.close();
    }
  });

  it("does not delete a newer refresh owner when a stale claim is cleaned up", async () => {
    const database = await open(await databasePath());
    try {
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
    } finally {
      await database.close();
    }
  });

  it("claims OAuth attempts once, records durable outcomes, and enforces browser binding", async () => {
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
    } finally {
      await database.close();
    }
  });

  it("fails processing attempts and retains terminal status until expiry", async () => {
    const database = await open(await databasePath());
    try {
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
    } finally {
      await database.close();
    }
  });

  it("cleans expired attempts and fences their processing reconnect refresh claims", async () => {
    const filename = await databasePath();
    const database = await open(filename);
    const integrationId = await database.run(
      Effect.gen(function* () {
        const integrations = yield* IntegrationRepo;
        const integration = yield* integrations.insert({
          name: "OAuth connection",
          type: "linear",
          config: {},
        });
        yield* integrations.claimRefresh({
          integrationId: integration.id,
          claimId: "expired_state",
          expectedRevision: integration.configRevision,
        });
        yield* integrations.createOAuthAuthorizationAttempt({
          stateHash: "expired_state",
          integrationId: integration.id,
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          browserBindingHash: "browser_hash",
          payload: {
            kind: "reconnect",
            redirectUri: "https://example.test/oauth/callback",
            configRevision: 0,
          },
        });
        yield* integrations.claimOAuthAuthorizationAttempt({
          stateHash: "expired_state",
          browserBindingHash: "browser_hash",
          expiresAt: new Date("2099-01-01T00:01:00Z"),
        });
        return integration.id;
      })
    );
    await database.close();

    const expiration = new DatabaseSync(filename);
    try {
      expiration
        .prepare(
          "UPDATE oauth_authorization_attempts SET expires_at = ? WHERE state_hash = ?"
        )
        .run(new Date("2000-01-01T00:00:00Z").getTime(), "expired_state");
    } finally {
      expiration.close();
    }

    const reopened = await open(filename);
    try {
      await reopened.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          yield* integrations.createOAuthAuthorizationAttempt({
            stateHash: "active_state",
            integrationId: null,
            expiresAt: new Date("2099-01-01T00:00:00Z"),
            browserBindingHash: "browser_hash",
            payload: {
              kind: "create",
              integrationId: "int_active",
              name: "Active OAuth connection",
              type: "linear",
              config: {},
              configRevision: 0,
              redirectUri: "https://example.test/oauth/callback",
            },
          });
        })
      );

      const afterCleanup = await reopened.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          return yield* integrations.findById(integrationId);
        })
      );
      expect(afterCleanup).toMatchObject({
        refreshState: "reauthorization_required",
        refreshClaimId: null,
      });
    } finally {
      await reopened.close();
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
    -- Migration step 5 rebuilds workflow_versions, so this fixture includes
    -- the workflow tables a database at that version actually had.
    CREATE TABLE workflows (id TEXT PRIMARY KEY) STRICT;
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

  it("rejects a stored refresh state outside the shared lifecycle", async () => {
    const filename = await databasePath();
    const database = await open(filename);
    let integrationId: string;
    try {
      integrationId = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "Corrupt state",
            type: "linear",
            config: { apiKey: "secret" },
          });
          return integration.id;
        })
      );
    } finally {
      await database.close();
    }

    const inspection = new DatabaseSync(filename);
    try {
      inspection.exec("PRAGMA ignore_check_constraints = ON");
      inspection
        .prepare("UPDATE integrations SET refresh_state = ? WHERE id = ?")
        .run("not_a_refresh_state", integrationId!);
    } finally {
      inspection.close();
    }

    const corrupted = await open(filename);
    try {
      const error = await corrupted.run(
        Effect.flip(
          Effect.gen(function* () {
            const integrations = yield* IntegrationRepo;
            return yield* integrations.findById(integrationId!);
          })
        )
      );

      expect(error).toMatchObject({
        _tag: "DatabaseError",
        cause: expect.objectContaining({
          message: "Invalid SQLite refresh_state",
        }),
      });
    } finally {
      await corrupted.close();
    }
  });

  // The migration that added this column spells its three values out, because a
  // database already past that version will never run it again. This is what
  // says so: adding a fourth state to the shared list without a migration that
  // widens the CHECK fails here rather than at a customer's write.
  it("accepts every refresh state the shared lifecycle declares", async () => {
    const filename = await databasePath();
    const database = await open(filename);
    let integrationId = "";
    try {
      integrationId = await database.run(
        Effect.gen(function* () {
          const integrations = yield* IntegrationRepo;
          const integration = yield* integrations.insert({
            name: "Every state",
            type: "linear",
            config: { apiKey: "secret" },
          });
          return integration.id;
        })
      );
    } finally {
      await database.close();
    }

    const inspection = new DatabaseSync(filename);
    try {
      for (const state of INTEGRATION_REFRESH_STATES) {
        expect(() =>
          inspection
            .prepare("UPDATE integrations SET refresh_state = ? WHERE id = ?")
            .run(state, integrationId)
        ).not.toThrow();
      }
    } finally {
      inspection.close();
    }
  });
});
