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
  getOAuthClientMetadata,
  oauthBindingCookieName,
  readIntegrationOAuthAttemptStatus,
  startIntegrationOAuth,
} from "#src/backend/services/integrations/oauth";
import { deleteIntegration } from "#src/backend/services/integrations/integrations";
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

describe("OAuth client metadata", () => {
  it("rejects fields outside the public metadata allowlist", async () => {
    const result = await Effect.runPromise(
      Effect.result(getOAuthClientMetadata("example")).pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            makeAppContextLayer({
              publicUrl: "https://workflows.example.com",
              apiBasePath: "/api",
            }),
            stubExtensions({
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
                registerClient: (context) => ({
                  clientId: context.metadataDocumentUrl,
                  metadataDocument: {
                    client_id: context.metadataDocumentUrl,
                    client_name: "Workflow Graph",
                    client_uri: context.publicUrl,
                    redirect_uris: [context.callbackUrl],
                    grant_types: ["authorization_code"],
                    response_types: ["code"],
                    token_endpoint_auth_method: "none",
                    scope: "messages:write",
                    private_key: "must-never-be-published",
                  } as never,
                }),
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
            })
          )
        )
      )
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InternalFailure);
    }
  });

  it("rejects metadata that advertises a different callback", async () => {
    const metadataUrl =
      "https://workflows.example.com/api/integrations/oauth/clients/example";
    const result = await Effect.runPromise(
      Effect.result(getOAuthClientMetadata("example")).pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            makeAppContextLayer({
              publicUrl: "https://workflows.example.com",
              apiBasePath: "/api",
            }),
            stubExtensions({
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
                registerClient: () => ({
                  clientId: metadataUrl,
                  metadataDocument: {
                    client_id: metadataUrl,
                    redirect_uris: ["https://attacker.example/callback"],
                  },
                }),
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
            })
          )
        )
      )
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InternalFailure);
    }
  });

  it.each([
    {
      name: "a nested client name",
      metadata: { client_name: { value: "Workflow Graph" } },
    },
    {
      name: "a scalar redirect URI list",
      metadata: { redirect_uris: "https://workflows.example.com/callback" },
    },
  ])("rejects $name in public metadata", async ({ metadata }) => {
    const metadataUrl =
      "https://workflows.example.com/api/integrations/oauth/clients/example";
    const result = await Effect.runPromise(
      Effect.result(getOAuthClientMetadata("example")).pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            appContext,
            stubExtensions({
              oauthFor: () => ({
                label: "Example OAuth",
                registerClient: () => ({
                  clientId: metadataUrl,
                  metadataDocument: {
                    client_id: metadataUrl,
                    redirect_uris: [
                      "https://workflows.example.com/api/integrations/oauth/callback",
                    ],
                    ...metadata,
                  } as never,
                }),
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
            })
          )
        )
      )
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(InternalFailure);
    }
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
      Effect.result(
        startIntegrationOAuth({ mode: "reconnect", integrationId: "int_1" })
      ).pipe(
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

describe("OAuth attempt status", () => {
  it("keeps internal processing status pending to the browser", async () => {
    const status = await Effect.runPromise(
      readIntegrationOAuthAttemptStatus({
        attemptId: "a".repeat(43),
        browserBinding: "binding",
      }).pipe(
        Effect.provide(
          stubIntegrationRepo({
            readOAuthAuthorizationAttemptStatus: () =>
              Effect.succeed({ status: "processing" }),
          })
        )
      )
    );

    expect(status).toEqual({ status: "pending" });
  });
});

const appContext = makeAppContextLayer({
  publicUrl: "https://workflows.example.com",
  apiBasePath: "/api",
});
const failAttempt = () => Effect.succeed(true);

function oauthExtensions(overrides: {
  registerClient?: () => { clientId: string };
  exchange?: () => Promise<{
    credentials: Record<string, string>;
    tokens: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
    };
    accountLabel?: string;
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
  it("revokes an OAuth grant before deleting its integration row", async () => {
    let current: DecryptedIntegration | null = integrationWithGrant(
      "old-access",
      0
    );
    const operations: string[] = [];
    const repository: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      claimRefresh: ({ claimId, expectedRevision }) =>
        Effect.sync(() => {
          if (
            !current ||
            current.configRevision !== expectedRevision ||
            current.refreshState === "refreshing"
          ) {
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
          if (!current || current.refreshClaimId !== claimId) return false;
          current = {
            ...current,
            config,
            configRevision: current.configRevision + 1,
            refreshState: "idle",
            refreshClaimId: null,
            refreshClaimedAt: null,
          };
          return true;
        }),
      deleteOwnedRefreshClaim: ({ claimId }) =>
        Effect.sync(() => {
          expect(readStoredOAuthGrant(current?.config ?? {})).toBeNull();
          expect(current?.refreshClaimId).toBe(claimId);
          operations.push("delete");
          current = null;
          return { status: "deleted" as const };
        }),
    };

    const result = await Effect.runPromise(
      deleteIntegration("int_1").pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            appContext,
            stubExtensions(
              oauthExtensions({
                revoke: async () => {
                  operations.push("revoke");
                },
              })
            ),
            stubIntegrationRepo(repository)
          )
        )
      )
    );

    expect(result).toEqual({ success: true });
    expect(operations).toEqual(["revoke", "delete"]);
    expect(current).toBeNull();
  });

  it("refuses to delete a row whose reserved OAuth grant is malformed", async () => {
    const integration = integrationWithGrant("old-access", 0);
    integration.config[OAUTH_GRANT_CONFIG_KEY] = "not-a-grant";
    let deleteCalls = 0;
    const repository = stubIntegrationRepo({
      findById: () => Effect.succeed(integration),
      deleteOwnedRefreshClaim: () =>
        Effect.sync(() => {
          deleteCalls += 1;
          return { status: "deleted" as const };
        }),
    });

    const failure = await Effect.runPromise(
      deleteIntegration("int_1").pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            appContext,
            stubExtensions(oauthExtensions({ revoke: async () => undefined })),
            repository
          )
        ),
        Effect.flip
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
    expect(deleteCalls).toBe(0);
  });

  it("lets one concurrent callback exchange and never revokes installation-wide cleanup", async () => {
    let current = integrationWithGrant("old-access", 0);
    let exchangeCalls = 0;
    const revoked: string[] = [];
    const repo: Partial<IntegrationRepo["Service"]> = {
      claimOAuthAuthorizationAttempt: () =>
        Effect.succeed({
          integrationId: current.id,
          payload: {
            kind: "reconnect",
            redirectUri:
              "https://workflows.example.com/api/integrations/oauth/callback",
            configRevision: 0,
          },
        }),
      failOAuthAuthorizationAttempt: failAttempt,
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
      completeOAuthReconnectAttempt: ({ stateHash, config }) =>
        Effect.sync(() => {
          if (current.refreshClaimId !== stateHash) return false;
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

describe("deferred OAuth creation", () => {
  const callbackInput = {
    state: "state",
    browserBinding: "binding",
    code: "code",
    providerError: undefined,
  };
  const createAttempt = {
    integrationId: null,
    payload: {
      kind: "create" as const,
      integrationId: "int_reserved",
      configRevision: 0 as const,
      name: "Example",
      type: "example",
      config: { MANUAL_TOKEN: "manual" },
      redirectUri:
        "https://workflows.example.com/api/integrations/oauth/callback",
    },
  };

  it("leaves no integration row when the provider declines authorization", async () => {
    let inserted = false;
    const result = await Effect.runPromise(
      Effect.result(
        completeIntegrationOAuth({
          ...callbackInput,
          code: undefined,
          providerError: "access_denied",
        })
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            appContext,
            stubExtensions(oauthExtensions({ revoke: async () => undefined })),
            stubIntegrationRepo({
              claimOAuthAuthorizationAttempt: () =>
                Effect.succeed(createAttempt),
              failOAuthAuthorizationAttempt: failAttempt,
              completeOAuthCreateAttempt: () =>
                Effect.sync(() => {
                  inserted = true;
                  return true;
                }),
            })
          )
        )
      )
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(inserted).toBe(false);
  });

  it("revokes an issued grant when its credentials do not match the integration", async () => {
    const revoked: string[] = [];
    const result = await Effect.runPromise(
      Effect.result(completeIntegrationOAuth(callbackInput)).pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            appContext,
            stubExtensions(
              oauthExtensions({
                exchange: async () => ({
                  credentials: { UNDECLARED_TOKEN: "issued-access" },
                  tokens: { accessToken: "issued-access" },
                }),
                revoke: async (accessToken) => {
                  revoked.push(accessToken);
                },
              })
            ),
            stubIntegrationRepo({
              claimOAuthAuthorizationAttempt: () =>
                Effect.succeed(createAttempt),
              failOAuthAuthorizationAttempt: failAttempt,
            })
          )
        )
      )
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(revoked).toEqual(["issued-access"]);
  });

  it("revokes an issued grant when its normalized fields are invalid", async () => {
    const revoked: string[] = [];
    const result = await Effect.runPromise(
      Effect.result(completeIntegrationOAuth(callbackInput)).pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            appContext,
            stubExtensions(
              oauthExtensions({
                exchange: async () => ({
                  credentials: { ACCESS_TOKEN: "issued-access" },
                  tokens: {
                    accessToken: "issued-access",
                    expiresAt: "not-a-timestamp",
                  },
                }),
                revoke: async (accessToken) => {
                  revoked.push(accessToken);
                },
              })
            ),
            stubIntegrationRepo({
              claimOAuthAuthorizationAttempt: () =>
                Effect.succeed(createAttempt),
              failOAuthAuthorizationAttempt: failAttempt,
            })
          )
        )
      )
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(revoked).toEqual(["issued-access"]);
  });

  it("revokes an issued grant when inserting the new connection fails", async () => {
    const revoked: string[] = [];
    const failure = await Effect.runPromise(
      completeIntegrationOAuth(callbackInput).pipe(
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
            stubIntegrationRepo({
              claimOAuthAuthorizationAttempt: () =>
                Effect.succeed(createAttempt),
              failOAuthAuthorizationAttempt: failAttempt,
              completeOAuthCreateAttempt: () =>
                Effect.fail(new DatabaseError({ cause: "insert failed" })),
              readOAuthAuthorizationAttemptStatus: () => Effect.succeed(null),
              findById: () => Effect.succeed(null),
            })
          )
        ),
        Effect.flip
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
    expect(revoked).toEqual(["new-access"]);
  });

  it("does not revoke or fence when the create commit result is uncertain", async () => {
    const revoked: string[] = [];
    const failure = await Effect.runPromise(
      completeIntegrationOAuth(callbackInput).pipe(
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
            stubIntegrationRepo({
              claimOAuthAuthorizationAttempt: () =>
                Effect.succeed(createAttempt),
              failOAuthAuthorizationAttempt: failAttempt,
              completeOAuthCreateAttempt: () =>
                Effect.fail(new DatabaseError({ cause: "result lost" })),
              readOAuthAuthorizationAttemptStatus: () =>
                Effect.fail(new DatabaseError({ cause: "status unavailable" })),
            })
          )
        ),
        Effect.flip
      )
    );

    expect(failure).toBeInstanceOf(InternalFailure);
    expect(revoked).toEqual([]);
  });

  it("accepts a create completion whose committed success is read back", async () => {
    const revoked: string[] = [];
    const result = await Effect.runPromise(
      Effect.result(completeIntegrationOAuth(callbackInput)).pipe(
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
            stubIntegrationRepo({
              claimOAuthAuthorizationAttempt: () =>
                Effect.succeed(createAttempt),
              failOAuthAuthorizationAttempt: failAttempt,
              completeOAuthCreateAttempt: () =>
                Effect.fail(new DatabaseError({ cause: "result lost" })),
              readOAuthAuthorizationAttemptStatus: () =>
                Effect.succeed({
                  status: "succeeded",
                  integrationId: "int_reserved",
                }),
            })
          )
        )
      )
    );

    expect(Result.isSuccess(result)).toBe(true);
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
      failOAuthAuthorizationAttempt: failAttempt,
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

    expect(result).toEqual({ success: true });
    expect(completedConfig).toEqual({
      ACCESS_TOKEN: "manual-token",
      DEFAULT_SENDER: "alerts@example.com",
    });
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
