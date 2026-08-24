import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { wfSqlite } from "#src/backend/persistence/sqlite";

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
  it("upgrades version 2 OAuth attempts to a nullable integration id", async () => {
    const filename = await databasePath();
    const versionTwo = new DatabaseSync(filename);
    versionTwo.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE integrations (id TEXT PRIMARY KEY) STRICT;
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
      const integrationIdColumn = inspection
        .prepare("PRAGMA table_info(oauth_authorization_attempts)")
        .all()
        .find((column) => column.name === "integration_id");
      expect(integrationIdColumn?.notnull).toBe(0);
      expect(
        inspection
          .prepare(
            "SELECT state_hash, integration_id FROM oauth_authorization_attempts"
          )
          .get()
      ).toEqual({ state_hash: "state", integration_id: "int_existing" });
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
            stateHash: "expired_state",
            integrationId: integration.id,
            expiresAt: new Date("2000-01-01T00:00:00Z"),
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
              redirectUri: "https://example.test/oauth/callback",
              codeVerifier: "create_verifier",
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
            create: yield* integrations.consumeOAuthAuthorizationAttempt(
              "create_state",
              "browser_hash"
            ),
          };
        })
      );

      expect(result).toEqual({
        valid: {
          integrationId: expect.any(String),
          payload: {
            kind: "reconnect",
            redirectUri: "https://example.test/oauth/callback",
            configRevision: 0,
            codeVerifier: "valid_verifier",
          },
        },
        replay: null,
        wrongBrowser: null,
        wrongBrowserReplay: null,
        expired: null,
        create: {
          integrationId: null,
          payload: {
            kind: "create",
            integrationId: "int_reserved",
            name: "New OAuth connection",
            type: "linear",
            config: { MANUAL_TOKEN: "manual" },
            redirectUri: "https://example.test/oauth/callback",
            codeVerifier: "create_verifier",
          },
        },
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
            kind: "reconnect",
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
            kind: "reconnect",
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
});
