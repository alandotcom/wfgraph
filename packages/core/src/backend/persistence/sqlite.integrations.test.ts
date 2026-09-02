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

  // The baseline spells these values out. Adding a state to the shared list
  // without a migration that widens the CHECK fails here.
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
