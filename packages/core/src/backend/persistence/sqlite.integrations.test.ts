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
