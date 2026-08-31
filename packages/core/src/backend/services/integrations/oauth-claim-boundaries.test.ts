import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import {
  SilentAppLoggerLayer,
  stubExtensions,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  completeIntegrationOAuth,
  deleteIntegrationOAuth,
} from "#src/backend/services/integrations/oauth";
import { InternalFailure } from "#src/backend/lib/effect/failures";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { readStoredOAuthGrant } from "#src/backend/services/integrations/oauth-grant";
import type {
  DecryptedIntegration,
  IntegrationRepo,
} from "#src/backend/services/integrations/repo";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  appContext,
  failedAttempt,
  integrationWithGrant,
  oauthExtensions,
} from "#src/backend/services/integrations/oauth.test-support";

describe("OAuth claim failure boundaries", () => {
  const callbackInput = {
    state: "state",
    browserBinding: "binding",
    code: "code",
    providerError: undefined,
  };

  function callbackRepo(
    integration: DecryptedIntegration,
    overrides: Partial<IntegrationRepo["Service"]>
  ): Partial<IntegrationRepo["Service"]> {
    return {
      claimOAuthAuthorizationAttempt: () =>
        Effect.succeed({
          integrationId: integration.id,
          payload: {
            kind: "reconnect",
            redirectUri:
              "https://workflows.example.com/api/integrations/oauth/callback",
            configRevision: integration.configRevision,
          },
        }),
      failOAuthAuthorizationAttempt: () => failedAttempt,
      findById: () => Effect.succeed(integration),
      claimRefresh: () => Effect.succeed({ status: "acquired" }),
      ...overrides,
    };
  }

  function oauthLayer(
    repo: Partial<IntegrationRepo["Service"]>,
    extensions: Partial<ExtensionSet>
  ) {
    return Layer.mergeAll(
      SilentAppLoggerLayer,
      appContext,
      stubExtensions(extensions),
      stubIntegrationRepo(repo)
    );
  }

  it("releases a callback claim when client registration fails before exchange", async () => {
    const integration = integrationWithGrant("old-access", 0);
    let released = 0;
    let exchangeCalls = 0;
    const repo = callbackRepo(integration, {
      releaseRefreshClaim: () =>
        Effect.sync(() => {
          released += 1;
          return true;
        }),
    });

    await Effect.runPromise(
      Effect.result(completeIntegrationOAuth(callbackInput)).pipe(
        Effect.provide(
          oauthLayer(
            repo,
            oauthExtensions({
              registerClient: () => {
                throw new Error("registration unavailable");
              },
              exchange: async () => {
                exchangeCalls += 1;
                throw new Error("must not exchange");
              },
              revoke: async () => undefined,
            })
          )
        )
      )
    );

    expect(released).toBe(1);
    expect(exchangeCalls).toBe(0);
  });

  it("marks reauthorization after callback exchange was invoked and failed", async () => {
    const integration = integrationWithGrant("old-access", 0);
    let exchangeCalls = 0;
    let marked = 0;
    const repo = callbackRepo(integration, {
      markReauthorizationRequired: () =>
        Effect.sync(() => {
          marked += 1;
          return { status: "transitioned" as const };
        }),
    });

    const failure = await Effect.runPromise(
      completeIntegrationOAuth(callbackInput).pipe(
        Effect.provide(
          oauthLayer(
            repo,
            oauthExtensions({
              exchange: async () => {
                exchangeCalls += 1;
                throw new Error("provider outcome unknown");
              },
              revoke: async () => undefined,
            })
          )
        ),
        Effect.flip
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
    expect(exchangeCalls).toBe(1);
    expect(marked).toBe(1);
  });

  it("rejects a damaged S256 attempt before invoking the adapter", async () => {
    const integration = integrationWithGrant("old-access", 0);
    let exchangeCalls = 0;
    let claimCalls = 0;
    const repo = callbackRepo(integration, {
      claimRefresh: () =>
        Effect.sync(() => {
          claimCalls += 1;
          return { status: "acquired" as const };
        }),
    });
    const extensions: Partial<ExtensionSet> = {
      catalog: {
        ...emptyExtensionCatalog,
        integrations: [
          {
            type: "example",
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
      oauthFor: () => ({
        label: "Example OAuth",
        pkce: "S256",
        registerClient: () => ({ clientId: "example-client" }),
        authorize: () => new URL("https://provider.example/authorize"),
        exchange: async () => {
          exchangeCalls += 1;
          return {
            credentials: { ACCESS_TOKEN: "new-access" },
            tokens: { accessToken: "new-access" },
          };
        },
        refresh: async () => ({
          credentials: { ACCESS_TOKEN: "refreshed-access" },
          tokens: { accessToken: "refreshed-access" },
        }),
        revoke: async () => undefined,
      }),
    };

    const failure = await Effect.runPromise(
      completeIntegrationOAuth(callbackInput).pipe(
        Effect.provide(oauthLayer(repo, extensions)),
        Effect.flip
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
    expect(exchangeCalls).toBe(0);
    expect(claimCalls).toBe(0);
  });

  it("marks reauthorization when callback completion has an unknown database outcome", async () => {
    const integration = integrationWithGrant("old-access", 0);
    let exchangeCalls = 0;
    let revokeCalls = 0;
    let marked = 0;
    const repo = callbackRepo(integration, {
      completeOAuthReconnectAttempt: () =>
        Effect.fail(new DatabaseError({ cause: new Error("connection lost") })),
      markReauthorizationRequired: () =>
        Effect.sync(() => {
          marked += 1;
          return { status: "transitioned" as const };
        }),
    });

    await Effect.runPromise(
      Effect.result(completeIntegrationOAuth(callbackInput)).pipe(
        Effect.provide(
          oauthLayer(
            repo,
            oauthExtensions({
              exchange: async () => {
                exchangeCalls += 1;
                return {
                  credentials: { ACCESS_TOKEN: "new-access" },
                  tokens: { accessToken: "new-access" },
                };
              },
              revoke: async () => {
                revokeCalls += 1;
              },
            })
          )
        )
      )
    );

    expect(exchangeCalls).toBe(1);
    expect(revokeCalls).toBe(0);
    expect(marked).toBe(1);
  });

  it("disconnect restores the manual credentials the grant was shadowing", async () => {
    const integration = integrationWithGrant("old-access", 0);
    integration.config = {
      ...integration.config,
      ACCESS_TOKEN: "manual-token",
      DEFAULT_SENDER: "alerts@example.com",
    };
    let completedConfig: DecryptedIntegration["config"] | undefined;
    const repository: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(integration),
      claimRefresh: () => Effect.succeed({ status: "acquired" }),
      completeRefresh: ({ config }) =>
        Effect.sync(() => {
          completedConfig = config;
          return true;
        }),
    };

    const result = await Effect.runPromise(
      deleteIntegrationOAuth("int_1").pipe(
        Effect.provide(
          oauthLayer(
            repository,
            oauthExtensions({ revoke: async () => undefined })
          )
        )
      )
    );

    expect(result).toEqual({ success: true, removed: false });
    expect(completedConfig).toEqual({
      ACCESS_TOKEN: "manual-token",
      DEFAULT_SENDER: "alerts@example.com",
    });
  });

  it("removes a connection the grant supplied on its own", async () => {
    const integration = integrationWithGrant("old-access", 0);
    let deleted = 0;
    let completionCalls = 0;
    const repository: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(integration),
      claimRefresh: () => Effect.succeed({ status: "acquired" }),
      completeRefresh: () =>
        Effect.sync(() => {
          completionCalls += 1;
          return true;
        }),
      deleteOwnedRefreshClaim: () =>
        Effect.sync(() => {
          deleted += 1;
          return { status: "deleted" as const };
        }),
    };

    const result = await Effect.runPromise(
      deleteIntegrationOAuth("int_1").pipe(
        Effect.provide(
          oauthLayer(
            repository,
            oauthExtensions({ revoke: async () => undefined })
          )
        )
      )
    );

    // Nothing is written back: a connection holding no credential of its own is
    // not a connection, so the row goes rather than being emptied.
    expect(result).toEqual({ success: true, removed: true });
    expect(deleted).toBe(1);
    expect(completionCalls).toBe(0);
  });

  it("fences the row when removing it loses the database", async () => {
    const integration = integrationWithGrant("old-access", 0);
    let marked = 0;
    const repository: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(integration),
      claimRefresh: () => Effect.succeed({ status: "acquired" }),
      deleteOwnedRefreshClaim: () =>
        Effect.fail(new DatabaseError({ cause: new Error("connection lost") })),
      markReauthorizationRequired: () =>
        Effect.sync(() => {
          marked += 1;
          return { status: "transitioned" as const };
        }),
    };

    const result = await Effect.runPromise(
      Effect.result(deleteIntegrationOAuth("int_1")).pipe(
        Effect.provide(
          oauthLayer(
            repository,
            oauthExtensions({ revoke: async () => undefined })
          )
        )
      )
    );

    // Revocation already happened and the row's fate is unknown, so it is
    // fenced rather than revoked again against what could be a newer grant.
    expect(marked).toBe(1);
    expect(Result.isFailure(result)).toBe(true);
  });

  it("releases a disconnect claim when provider revocation fails", async () => {
    const integration = integrationWithGrant("old-access", 0);
    let releaseCalls = 0;
    let completionCalls = 0;
    const repository: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(integration),
      claimRefresh: () => Effect.succeed({ status: "acquired" }),
      releaseRefreshClaim: () =>
        Effect.sync(() => {
          releaseCalls += 1;
          return true;
        }),
      completeRefresh: () =>
        Effect.sync(() => {
          completionCalls += 1;
          return true;
        }),
    };

    await Effect.runPromise(
      Effect.result(deleteIntegrationOAuth("int_1")).pipe(
        Effect.provide(
          oauthLayer(
            repository,
            oauthExtensions({
              revoke: async () => {
                throw new Error("provider refused revocation");
              },
            })
          )
        )
      )
    );

    expect(releaseCalls).toBe(1);
    expect(completionCalls).toBe(0);
  });

  it("keeps config and marks reauthorization after revoke completion loses the database", async () => {
    let current = integrationWithGrant("old-access", 0);
    // A manual credential is what makes this the retained-config path: with
    // none, disconnecting removes the row instead of writing one back.
    current.config = { ...current.config, ACCESS_TOKEN: "manual-token" };
    let revokeCalls = 0;
    let marked = 0;
    const repository = callbackRepo(current, {
      findById: () => Effect.sync(() => current),
      completeRefresh: () =>
        Effect.fail(new DatabaseError({ cause: new Error("connection lost") })),
      markReauthorizationRequired: () =>
        Effect.sync(() => {
          marked += 1;
          current = {
            ...current,
            refreshState: "reauthorization_required",
            refreshClaimId: null,
            refreshClaimedAt: null,
          };
          return { status: "transitioned" as const };
        }),
    });

    const run = () =>
      Effect.runPromise(
        Effect.result(deleteIntegrationOAuth("int_1")).pipe(
          Effect.provide(
            oauthLayer(
              repository,
              oauthExtensions({
                revoke: async () => {
                  revokeCalls += 1;
                },
              })
            )
          )
        )
      );

    await run();
    const retry = await run();

    expect(revokeCalls).toBe(1);
    expect(marked).toBe(1);
    expect(retry).toMatchObject({ failure: { _tag: "Conflict" } });
    expect(readStoredOAuthGrant(current.config)?.tokens.accessToken).toBe(
      "old-access"
    );
  });
});
