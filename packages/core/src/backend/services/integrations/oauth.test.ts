import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExtensions,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  completeIntegrationOAuth,
  deleteIntegrationOAuth,
  oauthBindingCookieName,
  startIntegrationOAuth,
} from "#src/backend/services/integrations/oauth";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import { Conflict, InternalFailure } from "#src/backend/lib/effect/failures";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  OAUTH_GRANT_CONFIG_KEY,
  readStoredOAuthGrant,
  serializeStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";
import type {
  DecryptedIntegration,
  IntegrationRepo,
} from "#src/backend/services/integrations/repo";

describe("OAuth browser binding cookie names", () => {
  it("accepts generated state and rejects characters that cannot enter a cookie name", () => {
    expect(oauthBindingCookieName("a".repeat(43))).toBe(
      `wfgraph_oauth_${"a".repeat(43)}`
    );
    expect(
      oauthBindingCookieName("state\r\nSet-Cookie: injected=1")
    ).toBeNull();
    expect(oauthBindingCookieName("short")).toBeNull();
  });
});

describe("OAuth provider failure logging", () => {
  it("records provider identity and operation while omitting the caught cause", async () => {
    const recording = makeRecordingLogger();
    const extensions: Partial<ExtensionSet> = {
      catalog: {
        ...emptyExtensionCatalog,
        integrations: [
          {
            type: "example",
            label: "Example",
            description: "Test integration",
            hasTest: false,
            credentialFields: {},
          },
        ],
      },
      oauthFor: () => ({
        label: "Example OAuth",
        registerClient: () => {
          throw new Error("authorization-code-and-token-value");
        },
        authorize: () => new URL("https://provider.example/authorize"),
        exchange: async () => ({
          credentials: {},
          tokens: { accessToken: "access" },
        }),
        refresh: async () => ({
          credentials: {},
          tokens: { accessToken: "access" },
        }),
        revoke: async () => undefined,
      }),
    };
    const repository = stubIntegrationRepo({
      findById: () =>
        Effect.succeed({
          id: "int_1",
          name: "Example",
          type: "example",
          config: {},
          configRevision: 0,
          isManaged: false,
          refreshState: "idle" as const,
          refreshClaimId: null,
          refreshClaimedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
    });

    await Effect.runPromise(
      Effect.result(startIntegrationOAuth("int_1")).pipe(
        Effect.provide(
          Layer.mergeAll(
            recording.layer,
            makeAppContextLayer({
              publicUrl: "https://workflows.example.com",
              apiBasePath: "/wfgraph/api",
            }),
            stubExtensions(extensions),
            repository
          )
        )
      )
    );

    expect(recording.lines).toEqual([
      {
        message: "OAuth provider client registration failed",
        properties: {
          operation: "client registration",
          provider: "example",
          integrationId: "int_1",
        },
      },
    ]);
    expect(JSON.stringify(recording.lines)).not.toContain(
      "authorization-code-and-token-value"
    );
  });
});

const appContext = makeAppContextLayer({
  publicUrl: "https://workflows.example.com",
  apiBasePath: "/api",
});

function oauthExtensions(overrides: {
  registerClient?: () => { clientId: string };
  exchange?: () => Promise<{
    credentials: Record<string, string>;
    tokens: { accessToken: string };
  }>;
  revoke: (accessToken: string) => Promise<void>;
}): Partial<ExtensionSet> {
  return {
    catalog: {
      ...emptyExtensionCatalog,
      integrations: [
        {
          type: "example",
          label: "Example",
          description: "Test integration",
          hasTest: false,
          credentialFields: {
            ACCESS_TOKEN: { label: "Access token", type: "password" },
          },
        },
      ],
    },
    oauthFor: () => ({
      label: "Example OAuth",
      registerClient:
        overrides.registerClient ?? (() => ({ clientId: "example-client" })),
      authorize: () => new URL("https://provider.example/authorize"),
      exchange:
        overrides.exchange ??
        (async () => ({
          credentials: { ACCESS_TOKEN: "new-access" },
          tokens: { accessToken: "new-access" },
        })),
      refresh: async () => ({
        credentials: { ACCESS_TOKEN: "refreshed-access" },
        tokens: { accessToken: "refreshed-access" },
      }),
      revoke: async ({ grant }) => overrides.revoke(grant.tokens.accessToken),
    }),
  };
}

function integrationWithGrant(
  accessToken: string,
  configRevision: number
): DecryptedIntegration {
  return {
    id: "int_1",
    name: "Example",
    type: "example",
    config: {
      [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant({
        credentials: { ACCESS_TOKEN: accessToken },
        tokens: { accessToken },
        connectedAt: "2026-08-24T00:00:00.000Z",
      }),
    },
    configRevision,
    isManaged: false,
    refreshState: "idle",
    refreshClaimId: null,
    refreshClaimedAt: null,
    createdAt: new Date("2026-08-24T00:00:00.000Z"),
    updatedAt: new Date("2026-08-24T00:00:00.000Z"),
  };
}

describe("OAuth config races", () => {
  it("lets one concurrent callback exchange and never revokes installation-wide cleanup", async () => {
    let current = integrationWithGrant("old-access", 0);
    let exchangeCalls = 0;
    const revoked: string[] = [];
    const repo: Partial<IntegrationRepo["Service"]> = {
      consumeOAuthAuthorizationAttempt: () =>
        Effect.succeed({
          integrationId: current.id,
          payload: {
            redirectUri:
              "https://workflows.example.com/api/integrations/oauth/callback",
            configRevision: 0,
          },
        }),
      findById: () => Effect.sync(() => current),
      claimRefresh: ({ claimId, expectedRevision }) =>
        Effect.sync(() => {
          expect(expectedRevision).toBe(0);
          if (current.refreshState !== "idle") {
            return { status: "lost" as const };
          }
          current = {
            ...current,
            refreshState: "refreshing",
            refreshClaimId: claimId,
            refreshClaimedAt: new Date(),
          };
          return { status: "acquired" as const };
        }),
      completeRefresh: ({ claimId, config }) =>
        Effect.sync(() => {
          if (current.refreshClaimId !== claimId) return false;
          current = {
            ...current,
            config,
            configRevision: 1,
            refreshState: "idle",
            refreshClaimId: null,
            refreshClaimedAt: null,
          };
          return true;
        }),
    };
    const extensions = oauthExtensions({
      exchange: async () => {
        exchangeCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          credentials: { ACCESS_TOKEN: "new-access" },
          tokens: { accessToken: "new-access" },
        };
      },
      revoke: async (accessToken) => {
        revoked.push(accessToken);
      },
    });
    const run = () =>
      Effect.runPromise(
        Effect.result(
          completeIntegrationOAuth({
            state: "state",
            browserBinding: "binding",
            code: "code",
            providerError: undefined,
          })
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              SilentAppLoggerLayer,
              appContext,
              stubExtensions(extensions),
              stubIntegrationRepo(repo)
            )
          )
        )
      );

    const outcomes = await Promise.all([run(), run()]);

    expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
    const failure = outcomes.find(Result.isFailure);
    expect(
      failure && Result.isFailure(failure) ? failure.failure : null
    ).toBeInstanceOf(Conflict);
    expect(exchangeCalls).toBe(1);
    expect(revoked).toEqual([]);
    expect(readStoredOAuthGrant(current.config)?.tokens.accessToken).toBe(
      "new-access"
    );
  });

  it("returns Conflict before disconnect revokes a refresh owner's grant", async () => {
    const revoked: string[] = [];
    const current = integrationWithGrant("old-access", 0);
    const repository = stubIntegrationRepo({
      findById: () => Effect.succeed(current),
      claimRefresh: () => Effect.succeed({ status: "lost" }),
    });

    const failure = await Effect.runPromise(
      deleteIntegrationOAuth("int_1").pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            appContext,
            stubExtensions(
              oauthExtensions({
                revoke: async (accessToken) => {
                  revoked.push(accessToken);
                },
              })
            ),
            repository
          )
        ),
        Effect.flip
      )
    );

    expect(failure).toBeInstanceOf(Conflict);
    expect(revoked).toEqual([]);
  });
});

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
      consumeOAuthAuthorizationAttempt: () =>
        Effect.succeed({
          integrationId: integration.id,
          payload: {
            redirectUri:
              "https://workflows.example.com/api/integrations/oauth/callback",
            configRevision: integration.configRevision,
          },
        }),
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
          return true;
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

  it("marks reauthorization when callback completion has an unknown database outcome", async () => {
    const integration = integrationWithGrant("old-access", 0);
    let exchangeCalls = 0;
    let revokeCalls = 0;
    let marked = 0;
    const repo = callbackRepo(integration, {
      completeRefresh: () =>
        Effect.fail(new DatabaseError({ cause: new Error("connection lost") })),
      markReauthorizationRequired: () =>
        Effect.sync(() => {
          marked += 1;
          return true;
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
          return true;
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
