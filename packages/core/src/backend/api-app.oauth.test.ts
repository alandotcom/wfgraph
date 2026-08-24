import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createApiApp } from "#src/backend/api-app";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { IntegrationOAuth } from "#src/backend/extensions/oauth";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import type { DecryptedIntegration } from "#src/backend/services/integrations/repo";
import type { OAuthAuthorizationAttemptPayload } from "#src/backend/services/integrations/repo";
import { OAUTH_GRANT_CONFIG_KEY } from "#src/backend/services/integrations/oauth-grant";
import { serializeStoredOAuthGrant } from "#src/backend/services/integrations/oauth-grant";
import {
  emptyExtensionCatalog,
  type IntegrationMetadata,
} from "@wfgraph/shared/extensions/catalog";

const basePath = "/wfgraph/api" as const;
const publicUrl = "https://workflows.example.com";
const oauthAppContext = { publicUrl, apiBasePath: basePath } as const;

const integration: DecryptedIntegration = {
  id: "int_1",
  name: "Example",
  type: "example",
  config: { MANUAL_TOKEN: "manual" },
  configRevision: 0,
  isManaged: false,
  refreshState: "idle",
  refreshClaimId: null,
  refreshClaimedAt: null,
  createdAt: new Date("2026-08-24T00:00:00.000Z"),
  updatedAt: new Date("2026-08-24T00:00:00.000Z"),
};

function provider(overrides: Partial<IntegrationOAuth> = {}): IntegrationOAuth {
  return {
    label: "Example OAuth",
    pkce: "S256",
    registerClient: () => ({
      clientId: `${publicUrl}${basePath}/integrations/oauth/clients/example`,
      metadataDocument: {
        client_id: `${publicUrl}${basePath}/integrations/oauth/clients/example`,
      },
    }),
    authorize: ({ state, codeChallenge }) =>
      new URL(
        `https://provider.example/authorize?state=${state}&challenge=${codeChallenge}`
      ),
    exchange: async () => ({
      credentials: { ACCESS_TOKEN: "provider-token" },
      tokens: { accessToken: "provider-token" },
      accountLabel: "Example account",
    }),
    refresh: async () => ({
      credentials: { ACCESS_TOKEN: "provider-token" },
      tokens: { accessToken: "provider-token" },
    }),
    revoke: async () => undefined,
    ...overrides,
  };
}

const exampleMetadata: IntegrationMetadata = {
  type: "example",
  label: "Example",
  description: "test integration",
  hasTest: false,
  credentialFields: {
    ACCESS_TOKEN: { label: "Access token", type: "password" },
  },
};

function extensions(oauth: IntegrationOAuth): Partial<ExtensionSet> {
  return {
    catalog: {
      ...emptyExtensionCatalog,
      integrations: [exampleMetadata],
    },
    oauthFor: (type: string) => (type === "example" ? oauth : undefined),
  };
}

describe("OAuth API routes", () => {
  it("refuses OAuth routes when the host has not configured a public URL", async () => {
    const runtime = stubWfGraphRuntime({
      appContext: { apiBasePath: basePath },
      extensions: extensions(provider()),
    });
    const app = createApiApp({
      basePath,
      authorize: () => Promise.resolve(true),
      runtime,
    });

    try {
      const response = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/int_1/oauth/start`
        )
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await runtime.dispose();
    }
  });

  it("publishes only the metadata document outside the host auth gate", async () => {
    const runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
    });
    const app = createApiApp({
      basePath,
      publicUrl,
      authorize: () => Promise.resolve(false),
      runtime,
    });

    try {
      const metadata = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/oauth/clients/example`
        )
      );
      expect(metadata.status).toBe(200);
      expect(metadata.headers.get("cache-control")).toBe("no-store");
      expect(await metadata.json()).toEqual({
        client_id: `${publicUrl}${basePath}/integrations/oauth/clients/example`,
      });
      const start = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/int_1/oauth/start`
        )
      );
      expect(start.status).toBe(401);
      expect(start.headers.get("cache-control")).toBe("no-store");
      const callback = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/oauth/callback?state=opaque`
        )
      );
      expect(callback.status).toBe(401);
      expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps the PKCE verifier in the attempt and uses its challenge in the redirect", async () => {
    let attempt:
      | {
          stateHash: string;
          browserBindingHash: string;
          payload: OAuthAuthorizationAttemptPayload;
        }
      | undefined;
    const runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        findById: () => Effect.succeed(integration),
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempt = input;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      publicUrl,
      authorize: () => Promise.resolve(true),
      runtime,
    });

    try {
      const response = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/int_1/oauth/start`
        )
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
      expect(attempt?.payload.codeVerifier).toBeDefined();
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(attempt?.payload.codeVerifier ?? "")
      );
      const challenge = Buffer.from(digest).toString("base64url");
      expect(
        new URL(response.headers.get("location")!).searchParams.get("challenge")
      ).toBe(challenge);
    } finally {
      await runtime.dispose();
    }
  });

  it("burns an authorization state when its cookie binding differs", async () => {
    const attempts = new Map<string, { browserBindingHash: string }>();
    let consumed = 0;
    const runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        findById: () => Effect.succeed(integration),
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempts.set(input.stateHash, input);
          }),
        consumeOAuthAuthorizationAttempt: (stateHash, browserBindingHash) =>
          Effect.sync(() => {
            consumed += 1;
            const attempt = attempts.get(stateHash);
            attempts.delete(stateHash);
            return attempt?.browserBindingHash === browserBindingHash
              ? {
                  integrationId: integration.id,
                  payload: {
                    redirectUri: "https://invalid.example/callback",
                    configRevision: 0,
                  },
                }
              : null;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      publicUrl,
      authorize: () => Promise.resolve(true),
      runtime,
    });

    try {
      const start = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/int_1/oauth/start`
        )
      );
      const state = new URL(start.headers.get("location")!).searchParams.get(
        "state"
      );
      const callback = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/oauth/callback?state=${state}&code=code`,
          { headers: { cookie: `wfgraph_oauth_${state}=wrong-binding` } }
        )
      );
      expect(callback.status).toBe(400);
      expect(consumed).toBe(1);
      expect(attempts.size).toBe(0);
      expect(await callback.text()).not.toContain("code");
    } finally {
      await runtime.dispose();
    }
  });

  it("consumes a provider error callback without exchanging a code", async () => {
    let exchangeCalls = 0;
    let attempt:
      | {
          stateHash: string;
          browserBindingHash: string;
          payload: OAuthAuthorizationAttemptPayload;
        }
      | undefined;
    const runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(
        provider({
          exchange: async () => {
            exchangeCalls += 1;
            return {
              credentials: { ACCESS_TOKEN: "provider-token" },
              tokens: { accessToken: "provider-token" },
            };
          },
        })
      ),
      integrationRepo: {
        findById: () => Effect.succeed(integration),
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempt = input;
          }),
        consumeOAuthAuthorizationAttempt: (stateHash, browserBindingHash) =>
          Effect.sync(() => {
            if (
              stateHash !== attempt?.stateHash ||
              browserBindingHash !== attempt.browserBindingHash
            ) {
              return null;
            }
            const consumed = attempt;
            attempt = undefined;
            return { integrationId: integration.id, payload: consumed.payload };
          }),
      },
    });
    const app = createApiApp({
      basePath,
      publicUrl,
      authorize: () => Promise.resolve(true),
      runtime,
    });

    try {
      const start = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/int_1/oauth/start`
        )
      );
      const state = new URL(start.headers.get("location")!).searchParams.get(
        "state"
      )!;
      const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
      const callback = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/oauth/callback?state=${state}&error=access_denied`,
          { headers: { cookie } }
        )
      );
      expect(callback.status).toBe(400);
      expect(exchangeCalls).toBe(0);
      expect(await callback.text()).not.toContain("access_denied");
    } finally {
      await runtime.dispose();
    }
  });

  it("persists a private grant while the callback page omits provider values", async () => {
    let attempt:
      | {
          stateHash: string;
          browserBindingHash: string;
          payload: OAuthAuthorizationAttemptPayload;
        }
      | undefined;
    let written: Record<string, string | undefined> | undefined;
    const runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        findById: () => Effect.succeed(integration),
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempt = input;
          }),
        consumeOAuthAuthorizationAttempt: (stateHash, browserBindingHash) =>
          Effect.sync(() => {
            if (
              stateHash !== attempt?.stateHash ||
              browserBindingHash !== attempt.browserBindingHash
            ) {
              return null;
            }
            return { integrationId: integration.id, payload: attempt.payload };
          }),
        claimRefresh: () => Effect.succeed({ status: "acquired" }),
        completeRefresh: ({ config }) =>
          Effect.sync(() => {
            written = config;
            return true;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      publicUrl,
      authorize: () => Promise.resolve(true),
      runtime,
    });

    try {
      const start = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/int_1/oauth/start`
        )
      );
      const state = new URL(start.headers.get("location")!).searchParams.get(
        "state"
      )!;
      const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
      const callback = await app.fetch(
        new Request(
          `http://localhost${basePath}/integrations/oauth/callback?state=${state}&code=provider-code`,
          { headers: { cookie } }
        )
      );
      const page = await callback.text();
      expect(callback.status).toBe(200);
      expect(callback.headers.get("cache-control")).toBe("no-store");
      expect(page).not.toContain("provider-token");
      expect(written?.MANUAL_TOKEN).toBe("manual");
      expect(written?.[OAUTH_GRANT_CONFIG_KEY]).toContain("provider-token");
    } finally {
      await runtime.dispose();
    }
  });

  it("retains the grant when provider revocation fails", async () => {
    const oauthConfig = {
      ...integration.config,
      [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant({
        credentials: { ACCESS_TOKEN: "provider-token" },
        tokens: { accessToken: "provider-token" },
        connectedAt: "2026-08-24T00:00:00.000Z",
      }),
    };
    const runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(
        provider({
          revoke: async () => {
            throw new Error("provider failure");
          },
        })
      ),
      integrationRepo: {
        findById: () => Effect.succeed({ ...integration, config: oauthConfig }),
        claimRefresh: () => Effect.succeed({ status: "acquired" }),
        releaseRefreshClaim: () => Effect.succeed(true),
        completeRefresh: () =>
          Effect.die("grant must remain stored after revoke failure"),
      },
    });
    const app = createApiApp({
      basePath,
      publicUrl,
      authorize: () => Promise.resolve(true),
      runtime,
    });

    try {
      const response = await app.fetch(
        new Request(`http://localhost${basePath}/integrations/int_1/oauth`, {
          method: "DELETE",
        })
      );
      expect(response.status).toBe(500);
    } finally {
      await runtime.dispose();
    }
  });

  it("disconnects through the config replacement that resets refresh state", async () => {
    const oauthConfig = {
      ...integration.config,
      [OAUTH_GRANT_CONFIG_KEY]: serializeStoredOAuthGrant({
        credentials: { ACCESS_TOKEN: "provider-token" },
        tokens: { accessToken: "provider-token" },
        connectedAt: "2026-08-24T00:00:00.000Z",
      }),
    };
    let replacement: Record<string, string | undefined> | undefined;
    const runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        findById: () => Effect.succeed({ ...integration, config: oauthConfig }),
        claimRefresh: () => Effect.succeed({ status: "acquired" }),
        completeRefresh: ({ config }) =>
          Effect.sync(() => {
            replacement = config;
            return true;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      publicUrl,
      authorize: () => Promise.resolve(true),
      runtime,
    });

    try {
      const response = await app.fetch(
        new Request(`http://localhost${basePath}/integrations/int_1/oauth`, {
          method: "DELETE",
        })
      );

      expect(response.status).toBe(200);
      expect(replacement).toEqual({ MANUAL_TOKEN: "manual" });
    } finally {
      await runtime.dispose();
    }
  });
});
