import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExtensions,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  makeAppContextLayer,
  type WfGraphAppContext,
} from "#src/backend/lib/effect/app-context";
import { OAUTH_REFRESH_CLAIM_STALE_MS } from "#src/backend/services/integrations/credential-resolver";
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

    expect(result).toEqual({ success: true, oauthRevocation: "revoked" });
    expect(operations).toEqual(["revoke", "delete"]);
    expect(current).toBeNull();
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

/**
 * A delete is the exit from every OAuth state, so none of these may leave the
 * row behind. Each case names a way revocation cannot happen.
 */
describe("deleting an OAuth connection the provider will not revoke", () => {
  function deletionRepo(integration: DecryptedIntegration) {
    const calls = { claims: [] as string[], deletes: 0, fenced: 0 };
    const repository: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(integration),
      claimRefresh: ({ from }) =>
        Effect.sync(() => {
          calls.claims.push(from);
          return { status: "acquired" as const };
        }),
      deleteOwnedRefreshClaim: () =>
        Effect.sync(() => {
          calls.deletes += 1;
          return { status: "deleted" as const };
        }),
      markReauthorizationRequired: () =>
        Effect.sync(() => {
          calls.fenced += 1;
          return { status: "transitioned" as const };
        }),
    };
    return { repository, calls };
  }

  async function deleteWith(input: {
    integration: DecryptedIntegration;
    revoke?: (accessToken: string) => Promise<void>;
    oauthDeclared?: boolean;
    context?: Layer.Layer<WfGraphAppContext>;
    repository: Partial<IntegrationRepo["Service"]>;
  }) {
    const recording = makeRecordingLogger();
    const extensions = oauthExtensions({
      revoke: input.revoke ?? (async () => undefined),
    });
    const result = await Effect.runPromise(
      deleteIntegration(input.integration.id).pipe(
        Effect.provide(
          Layer.mergeAll(
            recording.layer,
            input.context ?? appContext,
            stubExtensions(
              input.oauthDeclared === false
                ? { ...extensions, oauthFor: () => undefined }
                : extensions
            ),
            stubIntegrationRepo(input.repository)
          )
        )
      )
    );
    return { result, recording };
  }

  it("deletes the row and reports the grant unrevoked when the provider refuses", async () => {
    const integration = integrationWithGrant("uninstalled-access", 0);
    const { repository, calls } = deletionRepo(integration);

    const { result, recording } = await deleteWith({
      integration,
      repository,
      revoke: async () => {
        throw new Error("Slack OAuth request rejected: invalid_client_id");
      },
    });

    expect(result).toEqual({ success: true, oauthRevocation: "not_revoked" });
    expect(calls.deletes).toBe(1);
    expect(recording.warnLines).toEqual([
      {
        message:
          "Deleted an OAuth connection whose grant was not revoked at the provider",
        properties: {
          oauth: { provider: "example", reason: "provider_failed" },
        },
      },
    ]);
  });

  it("claims a connection fenced for reauthorization and deletes it", async () => {
    const integration: DecryptedIntegration = {
      ...integrationWithGrant("uncertain-access", 3),
      refreshState: "reauthorization_required",
    };
    const { repository, calls } = deletionRepo(integration);
    const revoked: string[] = [];

    const { result } = await deleteWith({
      integration,
      repository,
      revoke: async (accessToken) => {
        revoked.push(accessToken);
      },
    });

    expect(result).toEqual({ success: true, oauthRevocation: "revoked" });
    expect(calls.claims).toEqual(["reauthorization_required"]);
    expect(revoked).toEqual(["uncertain-access"]);
    expect(calls.deletes).toBe(1);
  });

  it("deletes the row when the integration no longer declares OAuth", async () => {
    const integration = integrationWithGrant("orphaned-access", 0);
    const { repository, calls } = deletionRepo(integration);

    const { result, recording } = await deleteWith({
      integration,
      repository,
      oauthDeclared: false,
    });

    expect(result).toEqual({ success: true, oauthRevocation: "not_revoked" });
    expect(calls.deletes).toBe(1);
    expect(recording.warnLines[0]?.properties).toEqual({
      oauth: { provider: "example", reason: "oauth_unavailable" },
    });
  });

  it("deletes the row when the host no longer configures publicUrl", async () => {
    const integration = integrationWithGrant("stranded-access", 0);
    const { repository, calls } = deletionRepo(integration);
    let revokeCalls = 0;

    const { result, recording } = await deleteWith({
      integration,
      repository,
      context: makeAppContextLayer({ apiBasePath: "/api" }),
      revoke: async () => {
        revokeCalls += 1;
      },
    });

    expect(result).toEqual({ success: true, oauthRevocation: "not_revoked" });
    expect(revokeCalls).toBe(0);
    expect(calls.deletes).toBe(1);
    expect(recording.warnLines[0]?.properties).toEqual({
      oauth: { provider: "example", reason: "public_url_missing" },
    });
  });

  it("deletes a row whose reserved OAuth grant is malformed", async () => {
    const integration = integrationWithGrant("old-access", 0);
    integration.config[OAUTH_GRANT_CONFIG_KEY] = "not-a-grant";
    const { repository, calls } = deletionRepo(integration);

    const { result } = await deleteWith({ integration, repository });

    expect(result).toEqual({ success: true, oauthRevocation: "not_revoked" });
    expect(calls.deletes).toBe(1);
  });

  it("fences a refresh owner that stopped answering, then deletes", async () => {
    let current: DecryptedIntegration = {
      ...integrationWithGrant("abandoned-access", 2),
      refreshState: "refreshing",
      refreshClaimId: "dead-owner",
      refreshClaimedAt: new Date(Date.now() - OAUTH_REFRESH_CLAIM_STALE_MS - 1),
    };
    const fences: string[] = [];
    let deletes = 0;
    const repository: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.sync(() => current),
      markReauthorizationRequired: ({ claimId }) =>
        Effect.sync(() => {
          fences.push(claimId);
          current = {
            ...current,
            refreshState: "reauthorization_required",
            refreshClaimId: null,
            refreshClaimedAt: null,
          };
          return { status: "transitioned" as const };
        }),
      claimRefresh: ({ from }) =>
        Effect.succeed(
          from === current.refreshState
            ? { status: "acquired" as const }
            : { status: "lost" as const }
        ),
      deleteOwnedRefreshClaim: () =>
        Effect.sync(() => {
          deletes += 1;
          return { status: "deleted" as const };
        }),
    };

    const { result } = await deleteWith({ integration: current, repository });

    expect(fences).toEqual(["dead-owner"]);
    expect(deletes).toBe(1);
    expect(result).toEqual({ success: true, oauthRevocation: "revoked" });
  });

  it("fences a revoked grant when the delete loses the database", async () => {
    const integration = integrationWithGrant("revoked-access", 0);
    const { repository: base, calls } = deletionRepo(integration);
    let released = 0;
    const repository: Partial<IntegrationRepo["Service"]> = {
      ...base,
      deleteOwnedRefreshClaim: () =>
        Effect.fail(
          new DatabaseError({ cause: new Error("connection reset") })
        ),
      releaseRefreshClaim: () =>
        Effect.sync(() => {
          released += 1;
          return true;
        }),
    };

    const failure = await Effect.runPromise(
      deleteIntegration("int_1").pipe(
        Effect.provide(
          Layer.mergeAll(
            SilentAppLoggerLayer,
            appContext,
            stubExtensions(oauthExtensions({ revoke: async () => undefined })),
            stubIntegrationRepo(repository)
          )
        ),
        Effect.flip
      )
    );

    // The provider no longer honors the stored grant, so handing the row back
    // to idle would offer runs a dead credential.
    expect(failure).toBeInstanceOf(InternalFailure);
    expect(calls.fenced).toBe(1);
    expect(released).toBe(0);
  });
});
