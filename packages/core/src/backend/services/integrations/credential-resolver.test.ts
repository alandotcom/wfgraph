import { Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { IntegrationOAuth } from "#src/backend/extensions/oauth";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExtensions,
  stubIntegrationRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  OAUTH_GRANT_CONFIG_KEY,
  serializeStoredOAuthGrant,
} from "#src/backend/services/integrations/oauth-grant";
import {
  OAUTH_REFRESH_CLAIM_STALE_MS,
  resolveIntegrationCredentials,
} from "#src/backend/services/integrations/credential-resolver";
import type {
  DecryptedIntegration,
  IntegrationRepo,
} from "#src/backend/services/integrations/repo";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";

const integrationId = "int_1";
const integrationType = "example";
const connectedAt = "2026-08-01T00:00:00.000Z";

function storedGrant(
  input: {
    accessToken?: string | undefined;
    refreshToken?: string | undefined;
    expiresAt?: string | undefined;
    accountLabel?: string | undefined;
    grantedAccessLabel?: string | undefined;
  } = {}
): string {
  const accessToken = input.accessToken ?? "old-access";
  return serializeStoredOAuthGrant({
    credentials: { ACCESS_TOKEN: accessToken },
    tokens: {
      accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
    },
    connectedAt,
    accountLabel: input.accountLabel,
    grantedAccessLabel: input.grantedAccessLabel,
  });
}

function row(config: DecryptedIntegration["config"]): DecryptedIntegration {
  return {
    id: integrationId,
    name: "Example",
    type: integrationType,
    config,
    configRevision: 0,
    isManaged: false,
    refreshState: "idle",
    refreshClaimId: null,
    refreshClaimedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

function extensionSet(oauth?: IntegrationOAuth): Partial<ExtensionSet> {
  return {
    catalog: {
      ...emptyExtensionCatalog,
      integrations: [
        {
          type: integrationType,
          label: "Example",
          description: "Test integration",
          hasTest: true,
          hasWebhook: false,
          credentialFields: {
            ACCESS_TOKEN: { label: "Access token", type: "password" },
            MANUAL_TOKEN: { label: "Manual token", type: "password" },
          },
        },
      ],
    },
    oauthFor: (type) => (type === integrationType ? oauth : undefined),
  };
}

function provider(
  refresh: IntegrationOAuth["refresh"],
  registerClient: IntegrationOAuth["registerClient"] = () => ({
    clientId: "example-client",
  })
): IntegrationOAuth {
  return {
    label: "Example OAuth",
    registerClient,
    authorize: () => new URL("https://provider.example/authorize"),
    exchange: async () => ({
      credentials: { ACCESS_TOKEN: "exchange-access" },
      tokens: { accessToken: "exchange-access" },
    }),
    refresh,
    revoke: async () => undefined,
  };
}

function layerFor(
  repo: Partial<IntegrationRepo["Service"]>,
  oauth?: IntegrationOAuth,
  loggerLayer = SilentAppLoggerLayer
) {
  return Layer.mergeAll(
    loggerLayer,
    makeAppContextLayer({
      publicUrl: "https://workflows.example.com",
      apiBasePath: "/wfgraph/api",
    }),
    stubExtensions(extensionSet(oauth)),
    stubIntegrationRepo(repo)
  );
}

describe("resolveIntegrationCredentials", () => {
  it("keeps manual rows unchanged", async () => {
    const integration = row({
      ACCESS_TOKEN: "manual-access",
      MANUAL_TOKEN: "manual-only",
    });

    const resolved = await Effect.runPromise(
      resolveIntegrationCredentials(integrationId).pipe(
        Effect.provide(
          layerFor({ findById: () => Effect.succeed(integration) })
        )
      )
    );

    expect(resolved).toEqual({
      integrationType,
      oauthCredentialKeys: [],
      credentials: {
        ACCESS_TOKEN: "manual-access",
        MANUAL_TOKEN: "manual-only",
      },
    });
  });

  it("overlays a long-lived OAuth grant and makes no refresh request", async () => {
    let refreshCalls = 0;
    const integration = row({
      ACCESS_TOKEN: "manual-access",
      MANUAL_TOKEN: "manual-only",
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant(),
    });
    const oauth = provider(async () => {
      refreshCalls += 1;
      throw new Error("refresh must not run");
    });

    const resolved = await Effect.runPromise(
      resolveIntegrationCredentials(integrationId).pipe(
        Effect.provide(
          layerFor({ findById: () => Effect.succeed(integration) }, oauth)
        )
      )
    );

    expect(resolved.credentials).toEqual({
      ACCESS_TOKEN: "old-access",
      MANUAL_TOKEN: "manual-only",
    });
    expect(refreshCalls).toBe(0);
  });

  it("uses a grant whose expiry is beyond the refresh skew", async () => {
    const integration = row({
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
        refreshToken: "refresh-token",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      }),
    });

    const resolved = await Effect.runPromise(
      resolveIntegrationCredentials(integrationId).pipe(
        Effect.provide(
          layerFor({
            findById: () => Effect.succeed(integration),
            claimRefresh: () => Effect.die("a safe expiry must not be claimed"),
          })
        )
      )
    );

    expect(resolved.credentials.ACCESS_TOKEN).toBe("old-access");
  });

  it("fails safely when the reserved grant cannot be decoded", async () => {
    const integration = row({
      ACCESS_TOKEN: "manual-access",
      [OAUTH_GRANT_CONFIG_KEY]: "{damaged",
    });

    const outcome = await Effect.runPromise(
      Effect.result(resolveIntegrationCredentials(integrationId)).pipe(
        Effect.provide(
          layerFor({ findById: () => Effect.succeed(integration) })
        )
      )
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(outcome).toMatchObject({
      failure: {
        _tag: "InternalFailure",
        error: "Stored OAuth credentials are invalid.",
      },
    });
  });

  it("refreshes a near-expiry grant and atomically preserves connection metadata", async () => {
    let current: DecryptedIntegration = row({
      MANUAL_TOKEN: "manual-only",
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        accountLabel: "Workspace",
      }),
    });
    let refreshCalls = 0;
    let registrationContext:
      | Parameters<IntegrationOAuth["registerClient"]>[0]
      | undefined;
    const oauth = provider(
      async () => {
        refreshCalls += 1;
        return {
          credentials: { ACCESS_TOKEN: "new-access" },
          tokens: {
            accessToken: "new-access",
            refreshToken: "new-refresh",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
      },
      (context) => {
        registrationContext = context;
        return { clientId: "example-client" };
      }
    );
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      claimRefresh: ({ claimId }) =>
        Effect.sync(() => {
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
            refreshState: "idle",
            refreshClaimId: null,
            refreshClaimedAt: null,
          };
          return true;
        }),
    };

    const resolved = await Effect.runPromise(
      resolveIntegrationCredentials(integrationId).pipe(
        Effect.provide(layerFor(repo, oauth))
      )
    );

    expect(refreshCalls).toBe(1);
    expect(registrationContext).toEqual({
      publicUrl: "https://workflows.example.com",
      callbackUrl:
        "https://workflows.example.com/wfgraph/api/integrations/oauth/callback",
      metadataDocumentUrl:
        "https://workflows.example.com/wfgraph/api/integrations/oauth/clients/example",
    });
    expect(resolved.credentials).toEqual({
      ACCESS_TOKEN: "new-access",
      MANUAL_TOKEN: "manual-only",
    });
    expect(JSON.parse(current.config[OAUTH_GRANT_CONFIG_KEY]!)).toMatchObject({
      credentials: { ACCESS_TOKEN: "new-access" },
      tokens: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
      },
      connectedAt,
      accountLabel: "Workspace",
    });
  });

  it("stores the narrower access when a refresh reduces the grant", async () => {
    let current: DecryptedIntegration = row({
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() + 10_000).toISOString(),
        accountLabel: "Workspace",
        grantedAccessLabel: "Full access",
      }),
    });
    const oauth = provider(async () => ({
      credentials: { ACCESS_TOKEN: "new-access" },
      // The provider narrowed the grant. `accountLabel` is carried forward from
      // the old grant; this must not be, or the connection would keep claiming
      // access it no longer has.
      grantedAccessLabel: "Sending access",
      tokens: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    }));
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      claimRefresh: ({ claimId }) =>
        Effect.sync(() => {
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
          current = { ...current, config, refreshState: "idle" };
          return true;
        }),
    };

    await Effect.runPromise(
      resolveIntegrationCredentials(integrationId).pipe(
        Effect.provide(layerFor(repo, oauth))
      )
    );

    expect(JSON.parse(current.config[OAUTH_GRANT_CONFIG_KEY]!)).toMatchObject({
      grantedAccessLabel: "Sending access",
      accountLabel: "Workspace",
    });
  });

  it("releases an acquired claim when local provider registration fails", async () => {
    const integration = row({
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    });
    let claimCalls = 0;
    let releaseCalls = 0;
    const oauth = provider(
      async () => {
        throw new Error("refresh must not run");
      },
      () => {
        throw new Error("local registration is incomplete");
      }
    );

    await Effect.runPromise(
      Effect.result(resolveIntegrationCredentials(integrationId)).pipe(
        Effect.provide(
          layerFor(
            {
              findById: () => Effect.succeed(integration),
              claimRefresh: () =>
                Effect.sync(() => {
                  claimCalls += 1;
                  return { status: "acquired" as const };
                }),
              releaseRefreshClaim: () =>
                Effect.sync(() => {
                  releaseCalls += 1;
                  return true;
                }),
            },
            oauth
          )
        )
      )
    );

    expect(claimCalls).toBe(1);
    expect(releaseCalls).toBe(1);
  });

  it("makes no provider call when a reconnect invalidates the reader revision", async () => {
    let current = row({
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    });
    let registrationCalls = 0;
    let refreshCalls = 0;
    const oauth = provider(
      async () => {
        refreshCalls += 1;
        throw new Error("stale reader must not refresh");
      },
      () => {
        registrationCalls += 1;
        return { clientId: "example-client" };
      }
    );
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      claimRefresh: ({ expectedRevision }) =>
        Effect.sync(() => {
          expect(expectedRevision).toBe(0);
          current = {
            ...current,
            config: {
              [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
                accessToken: "reconnected-access",
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              }),
            },
            configRevision: 1,
          };
          return { status: "lost" as const };
        }),
    };

    const resolved = await Effect.runPromise(
      resolveIntegrationCredentials(integrationId).pipe(
        Effect.provide(layerFor(repo, oauth))
      )
    );

    expect(resolved.credentials.ACCESS_TOKEN).toBe("reconnected-access");
    expect(registrationCalls).toBe(0);
    expect(refreshCalls).toBe(0);
  });

  it("marks the owning claim for reauthorization after a provider request fails", async () => {
    let current = row({
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    });
    let refreshCalls = 0;
    const markedClaims: string[] = [];
    const recording = makeRecordingLogger();
    const oauth = provider(async () => {
      refreshCalls += 1;
      throw new Error("response included secret old-access");
    });
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      claimRefresh: ({ claimId }) =>
        Effect.sync(() => {
          current = {
            ...current,
            refreshState: "refreshing",
            refreshClaimId: claimId,
            refreshClaimedAt: new Date(),
          };
          return { status: "acquired" as const };
        }),
      markReauthorizationRequired: ({ claimId }) =>
        Effect.sync(() => {
          markedClaims.push(claimId);
          if (current.refreshClaimId !== claimId) {
            return { status: "no_longer_owned" as const };
          }
          current = {
            ...current,
            refreshState: "reauthorization_required",
            refreshClaimId: null,
            refreshClaimedAt: null,
          };
          return { status: "transitioned" as const };
        }),
    };
    const resolution = () =>
      Effect.runPromise(
        Effect.result(resolveIntegrationCredentials(integrationId)).pipe(
          Effect.provide(layerFor(repo, oauth, recording.layer))
        )
      );

    const first = await resolution();
    const second = await resolution();

    expect(first).toMatchObject({
      failure: {
        _tag: "InternalFailure",
        error: "OAuth credentials are unavailable. Reconnect the integration.",
      },
    });
    expect(second).toMatchObject({ failure: { _tag: "InternalFailure" } });
    expect(refreshCalls).toBe(1);
    expect(markedClaims).toHaveLength(1);
    expect(recording.lines).toEqual([
      {
        message: "OAuth provider token refresh failed",
        properties: {
          operation: "token refresh",
          provider: integrationType,
          integrationId,
        },
      },
    ]);
    expect(JSON.stringify(recording.lines)).not.toContain("old-access");
  });

  it("marks the owning claim when a provider returns an invalid token set", async () => {
    let current = row({
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    });
    let marked = false;
    const oauth = provider(async () => ({
      credentials: { ACCESS_TOKEN: "" },
      tokens: { accessToken: "" },
    }));
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      claimRefresh: ({ claimId }) =>
        Effect.sync(() => {
          current = {
            ...current,
            refreshState: "refreshing",
            refreshClaimId: claimId,
            refreshClaimedAt: new Date(),
          };
          return { status: "acquired" as const };
        }),
      completeRefresh: () => Effect.die("an invalid grant must not be stored"),
      markReauthorizationRequired: ({ claimId }) =>
        Effect.sync(() => {
          marked = current.refreshClaimId === claimId;
          return marked
            ? { status: "transitioned" as const }
            : { status: "no_longer_owned" as const };
        }),
    };

    const outcome = await Effect.runPromise(
      Effect.result(resolveIntegrationCredentials(integrationId)).pipe(
        Effect.provide(layerFor(repo, oauth))
      )
    );

    expect(outcome).toMatchObject({
      failure: {
        _tag: "InternalFailure",
        error: "OAuth credentials are unavailable. Reconnect the integration.",
      },
    });
    expect(marked).toBe(true);
  });

  it("lets concurrent callers share one rotating-token refresh", async () => {
    let current = row({
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    });
    let refreshCalls = 0;
    const oauth = provider(async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        credentials: { ACCESS_TOKEN: "replacement-access" },
        tokens: {
          accessToken: "replacement-access",
          refreshToken: "replacement-refresh",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    });
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.sync(() => current),
      claimRefresh: ({ claimId }) =>
        Effect.sync(() => {
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
            refreshState: "idle",
            refreshClaimId: null,
            refreshClaimedAt: null,
          };
          return true;
        }),
    };
    const run = () =>
      Effect.runPromise(
        resolveIntegrationCredentials(integrationId).pipe(
          Effect.provide(layerFor(repo, oauth))
        )
      );

    const [first, second] = await Promise.all([run(), run()]);

    expect(refreshCalls).toBe(1);
    expect(first.credentials.ACCESS_TOKEN).toBe("replacement-access");
    expect(second.credentials.ACCESS_TOKEN).toBe("replacement-access");
  });

  it("fences an abandoned owner into reauthorization instead of stealing its claim", async () => {
    const ownerClaimId = "owner-claim";
    let current: DecryptedIntegration = {
      ...row({
        [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
          refreshToken: "old-refresh",
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      }),
      refreshState: "refreshing",
      refreshClaimId: ownerClaimId,
      refreshClaimedAt: new Date(Date.now() - OAUTH_REFRESH_CLAIM_STALE_MS - 1),
    };
    const claims: string[] = [];
    const markedClaims: string[] = [];
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      claimRefresh: ({ claimId }) =>
        Effect.sync(() => {
          claims.push(claimId);
          return { status: "lost" as const };
        }),
      markReauthorizationRequired: ({ claimId }) =>
        Effect.sync(() => {
          markedClaims.push(claimId);
          if (claimId !== current.refreshClaimId) {
            return { status: "no_longer_owned" as const };
          }
          current = {
            ...current,
            refreshState: "reauthorization_required",
            refreshClaimId: null,
            refreshClaimedAt: null,
          };
          return { status: "transitioned" as const };
        }),
    };

    const outcome = await Effect.runPromise(
      Effect.result(resolveIntegrationCredentials(integrationId)).pipe(
        Effect.provide(layerFor(repo))
      )
    );

    expect(claims).toEqual([]);
    expect(markedClaims).toEqual([ownerClaimId]);
    expect(current.refreshState).toBe("reauthorization_required");
    expect(outcome).toMatchObject({
      failure: {
        _tag: "InternalFailure",
        error: "OAuth credentials are unavailable. Reconnect the integration.",
      },
    });
  });

  it("returns temporary unavailability when fencing a stale refresh owner fails", async () => {
    const current: DecryptedIntegration = {
      ...row({
        [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
          refreshToken: "old-refresh",
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      }),
      refreshState: "refreshing",
      refreshClaimId: "stale-owner",
      refreshClaimedAt: new Date(Date.now() - OAUTH_REFRESH_CLAIM_STALE_MS - 1),
    };
    let markCalls = 0;
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      markReauthorizationRequired: () =>
        Effect.fail(
          new DatabaseError({ cause: new Error("database unavailable") })
        ).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              markCalls += 1;
            })
          )
        ),
    };

    const outcome = await Effect.runPromise(
      Effect.result(resolveIntegrationCredentials(integrationId)).pipe(
        Effect.provide(layerFor(repo))
      )
    );

    expect(markCalls).toBe(1);
    expect(outcome).toMatchObject({
      failure: {
        _tag: "InternalFailure",
        error: "OAuth credentials are temporarily unavailable.",
      },
    });
  });

  it("rereads when the stale owner completes before reauthorization is fenced", async () => {
    const ownerClaimId = "owner-claim";
    const replacementGrant = storedGrant({
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    let current: DecryptedIntegration = {
      ...row({
        [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
          refreshToken: "old-refresh",
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      }),
      refreshState: "refreshing",
      refreshClaimId: ownerClaimId,
      refreshClaimedAt: new Date(Date.now() - OAUTH_REFRESH_CLAIM_STALE_MS - 1),
    };
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      markReauthorizationRequired: () =>
        Effect.sync(() => {
          current = {
            ...current,
            config: {
              ...current.config,
              [OAUTH_GRANT_CONFIG_KEY]: replacementGrant,
            },
            configRevision: current.configRevision + 1,
            refreshState: "idle",
            refreshClaimId: null,
            refreshClaimedAt: null,
          };
          return { status: "no_longer_owned" as const };
        }),
    };

    const resolved = await Effect.runPromise(
      resolveIntegrationCredentials(integrationId).pipe(
        Effect.provide(layerFor(repo))
      )
    );

    expect(resolved.credentials.ACCESS_TOKEN).toBe("replacement-access");
  });

  it("bounds how long a race loser polls a fresh refresh owner", async () => {
    const current: DecryptedIntegration = {
      ...row({
        [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
          refreshToken: "old-refresh",
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      }),
      refreshState: "refreshing",
      refreshClaimId: "active-owner",
      refreshClaimedAt: new Date(),
    };

    const outcome = await Effect.runPromise(
      Effect.result(resolveIntegrationCredentials(integrationId)).pipe(
        Effect.provide(layerFor({ findById: () => Effect.succeed(current) }))
      )
    );

    expect(outcome).toMatchObject({
      failure: {
        _tag: "InternalFailure",
        error: "OAuth credentials are temporarily unavailable.",
      },
    });
  });

  it("cannot complete or mark a newer refresh owner after its provider call", async () => {
    let current = row({
      [OAUTH_GRANT_CONFIG_KEY]: storedGrant({
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    });
    let originalClaimId = "";
    const markedClaims: string[] = [];
    const oauth = provider(async () => {
      current = {
        ...current,
        refreshState: "refreshing",
        refreshClaimId: "newer-owner",
        refreshClaimedAt: new Date(),
      };
      return {
        credentials: { ACCESS_TOKEN: "replacement-access" },
        tokens: {
          accessToken: "replacement-access",
          refreshToken: "replacement-refresh",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    });
    const repo: Partial<IntegrationRepo["Service"]> = {
      findById: () => Effect.succeed(current),
      claimRefresh: ({ claimId }) =>
        Effect.sync(() => {
          originalClaimId = claimId;
          current = {
            ...current,
            refreshState: "refreshing",
            refreshClaimId: claimId,
            refreshClaimedAt: new Date(),
          };
          return { status: "acquired" as const };
        }),
      completeRefresh: ({ claimId }) =>
        Effect.succeed(current.refreshClaimId === claimId),
      markReauthorizationRequired: ({ claimId }) =>
        Effect.sync(() => {
          markedClaims.push(claimId);
          return { status: "no_longer_owned" as const };
        }),
    };

    const outcome = await Effect.runPromise(
      Effect.result(resolveIntegrationCredentials(integrationId)).pipe(
        Effect.provide(layerFor(repo, oauth))
      )
    );

    expect(outcome).toMatchObject({ failure: { _tag: "InternalFailure" } });
    expect(markedClaims).toEqual([originalClaimId]);
    expect(current).toMatchObject({
      refreshState: "refreshing",
      refreshClaimId: "newer-owner",
    });
  });
});
