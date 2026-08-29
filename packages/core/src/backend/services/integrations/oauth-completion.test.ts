import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  SilentAppLoggerLayer,
  stubExtensions,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  completeIntegrationOAuth,
  deleteIntegrationOAuth,
} from "#src/backend/services/integrations/oauth";
import { deleteIntegration } from "#src/backend/services/integrations/integrations";
import { Conflict, InternalFailure } from "#src/backend/lib/effect/failures";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  OAUTH_GRANT_CONFIG_KEY,
  readStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";
import type {
  DecryptedIntegration,
  IntegrationRepo,
} from "#src/backend/services/integrations/repo";
import {
  appContext,
  failedAttempt,
  integrationWithGrant,
  oauthExtensions,
} from "#src/backend/services/integrations/oauth.test-support";

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
      failOAuthAuthorizationAttempt: () => failedAttempt,
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
              failOAuthAuthorizationAttempt: () => failedAttempt,
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
              failOAuthAuthorizationAttempt: () => failedAttempt,
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
              failOAuthAuthorizationAttempt: () => failedAttempt,
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
              failOAuthAuthorizationAttempt: () => failedAttempt,
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
              failOAuthAuthorizationAttempt: () => failedAttempt,
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
              failOAuthAuthorizationAttempt: () => failedAttempt,
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
