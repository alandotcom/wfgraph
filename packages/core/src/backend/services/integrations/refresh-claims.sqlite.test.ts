/**
 * The OAuth refresh claim through the integration services, over native
 * SQLite, where a second actor fences the row between one actor's read and
 * its claim. The repository cases in `persistence/conformance/integrations.ts`
 * cover the claim itself on both backends.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Result } from "effect";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { IntegrationOAuth } from "#src/backend/extensions/oauth";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import {
  SilentAppLoggerLayer,
  stubExtensions,
} from "#src/backend/lib/effect/test-layers";
import type {
  ConformanceConnection,
  ConformanceDatabase,
} from "#src/backend/persistence/conformance/support";
import { createSqliteTestDatabase } from "#src/backend/persistence/sqlite-test-database";
import { resolveIntegrationCredentials } from "#src/backend/services/integrations/credential-resolver";
import { getIntegration } from "#src/backend/services/integrations/integrations";
import {
  completeIntegrationOAuth,
  startIntegrationOAuth,
} from "#src/backend/services/integrations/oauth";
import {
  OAUTH_GRANT_CONFIG_KEY,
  serializeStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";
import { IntegrationRepo } from "#src/backend/services/integrations/repo";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const integrationType = "example";

const databases: ConformanceDatabase[] = [];
const connections: ConformanceConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((one) => one.close()));
  await Promise.all(databases.splice(0).map((one) => one.drop()));
});

function provider(overrides: Partial<IntegrationOAuth>): IntegrationOAuth {
  return {
    label: "Example OAuth",
    registerClient: () => ({ clientId: "example-client" }),
    authorize: () => new URL("https://provider.example/authorize"),
    exchange: async () => ({
      credentials: { ACCESS_TOKEN: "exchanged-access" },
      tokens: { accessToken: "exchanged-access" },
    }),
    refresh: async () => ({
      credentials: { ACCESS_TOKEN: "refreshed-access" },
      tokens: { accessToken: "refreshed-access", refreshToken: "rotated" },
    }),
    revoke: async () => undefined,
    ...overrides,
  };
}

/** A provider that refuses the stored refresh token. */
const refusingRefresh = provider({
  refresh: async () => {
    throw new Error("invalid_grant");
  },
});

function services(oauth: IntegrationOAuth) {
  const extensions: Partial<ExtensionSet> = {
    catalog: {
      ...emptyExtensionCatalog,
      integrations: [
        {
          type: integrationType,
          label: "Example",
          description: "Test integration",
          hasTest: false,
          hasWebhook: false,
          credentialFields: {
            ACCESS_TOKEN: { label: "Access token", type: "password" },
          },
        },
      ],
    },
    oauthFor: (type) => (type === integrationType ? oauth : undefined),
  };
  return Layer.mergeAll(
    SilentAppLoggerLayer,
    makeAppContextLayer({
      publicUrl: "https://workflows.example.com",
      apiBasePath: "/api",
    }),
    stubExtensions(extensions)
  );
}

/** A connection on a fresh database holding one grant due for refresh. */
async function withExpiredGrant(): Promise<{
  connection: ConformanceConnection;
  integrationId: string;
}> {
  const database = await createSqliteTestDatabase();
  databases.push(database);
  const connection = await database.open();
  connections.push(connection);
  const integration = await connection.run(
    Effect.gen(function* () {
      const integrations = yield* IntegrationRepo;
      return yield* integrations.insert({
        name: "Example",
        type: integrationType,
        config: {
          [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant({
            credentials: { ACCESS_TOKEN: "old-access" },
            tokens: {
              accessToken: "old-access",
              refreshToken: "old-refresh",
              expiresAt: "2020-01-01T00:00:00.000Z",
            },
            connectedAt: "2020-01-01T00:00:00.000Z",
          }),
        },
      });
    })
  );
  return { connection, integrationId: integration.id };
}

/** What the integrations page shows for the connection's OAuth grant. */
function oauthStatus(integrationId: string) {
  return getIntegration(integrationId).pipe(
    Effect.provide(services(provider({}))),
    Effect.map((integration) => integration.oauth?.status)
  );
}

describe("refresh claims through the integration services", () => {
  it("leaves a connection fenced for reauthorization when a resolver that read it idle claims it afterwards", async () => {
    const { connection, integrationId } = await withExpiredGrant();
    const result = await connection.run(
      Effect.gen(function* () {
        const stored = yield* IntegrationRepo;
        // A second resolver runs between this one's read and its claim, and
        // its provider refuses the refresh token, which fences the row.
        const fencedBeforeClaim: IntegrationRepo["Service"] = {
          ...stored,
          claimRefresh: (input) =>
            resolveIntegrationCredentials(integrationId).pipe(
              Effect.provide(services(refusingRefresh)),
              Effect.provideService(IntegrationRepo, stored),
              Effect.ignore,
              Effect.andThen(stored.claimRefresh(input))
            ),
        };
        const resolved = yield* Effect.result(
          resolveIntegrationCredentials(integrationId).pipe(
            Effect.provide(services(provider({}))),
            Effect.provideService(IntegrationRepo, fencedBeforeClaim)
          )
        );
        return { resolved, status: yield* oauthStatus(integrationId) };
      })
    );

    expect(Result.isFailure(result.resolved)).toBe(true);
    expect(result.status).toBe("reauthorization_required");
  });

  it("leaves a connection fenced for reauthorization when its reconnect fails before the code exchange", async () => {
    const { connection, integrationId } = await withExpiredGrant();
    const result = await connection.run(
      Effect.gen(function* () {
        yield* Effect.ignore(
          resolveIntegrationCredentials(integrationId).pipe(
            Effect.provide(services(refusingRefresh))
          )
        );
        const fenced = yield* oauthStatus(integrationId);
        const attempt = yield* startIntegrationOAuth({
          mode: "reconnect",
          integrationId,
        }).pipe(Effect.provide(services(provider({}))));
        const completion = yield* Effect.result(
          completeIntegrationOAuth({
            state: attempt.attemptId,
            browserBinding: attempt.browserBinding,
            code: "code",
            providerError: undefined,
          }).pipe(
            Effect.provide(
              services(
                provider({
                  registerClient: () => {
                    throw new Error("client registration is unavailable");
                  },
                })
              )
            )
          )
        );
        return {
          fenced,
          completion,
          status: yield* oauthStatus(integrationId),
        };
      })
    );

    expect(result.fenced).toBe("reauthorization_required");
    expect(Result.isFailure(result.completion)).toBe(true);
    expect(result.status).toBe("reauthorization_required");
  });
});
