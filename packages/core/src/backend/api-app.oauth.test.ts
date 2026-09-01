import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createApiApp, requestLogPath } from "#src/backend/api-app";
import {
  defineWfGraphAuth,
  resolveAuth,
  trustWfGraphUpstream,
} from "#src/backend/lib/http/authorize";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import type { IntegrationOAuth } from "#src/backend/extensions/oauth";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import type {
  DecryptedIntegration,
  IntegrationRepo,
  OAuthAuthorizationAttemptInput,
  OAuthAuthorizationAttemptStatus,
} from "#src/backend/services/integrations/repo";
import { OAUTH_GRANT_CONFIG_KEY } from "#src/backend/services/integrations/oauth-grant";
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
        redirect_uris: [`${publicUrl}${basePath}/integrations/oauth/callback`],
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
  hasWebhook: false,
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
  it("redacts the OAuth attempt state from request log paths", () => {
    expect(
      requestLogPath(
        "/wfgraph/api/integrations/oauth/attempts/opaque-provider-state"
      )
    ).toBe("/wfgraph/api/integrations/oauth/attempts/:attemptId");
  });

  it("starts a new OAuth connection without creating an integration row", async () => {
    let attempt: OAuthAuthorizationAttemptInput | undefined;
    let insertedIntegration = false;
    await using runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        insert: () =>
          Effect.sync(() => {
            insertedIntegration = true;
            return integration;
          }),
        insertWithId: () =>
          Effect.sync(() => {
            insertedIntegration = true;
            return integration;
          }),
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempt = input;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const response = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          name: "Example connection",
          type: "example",
          config: { MANUAL_TOKEN: "manual" },
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const body = await response.json();
    expect(body).toEqual({
      attemptId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      authorizeUrl: expect.stringMatching(
        /^https:\/\/provider\.example\/authorize\?/
      ),
    });
    expect(attempt?.integrationId).toBeNull();
    expect(attempt?.payload).toMatchObject({
      kind: "create",
      integrationId: expect.any(String),
      configRevision: 0,
      name: "Example connection",
      type: "example",
      config: { MANUAL_TOKEN: "manual" },
    });
    expect(insertedIntegration).toBe(false);
  });

  it("starts reconnect through the same POST route", async () => {
    let attempt: OAuthAuthorizationAttemptInput | undefined;
    await using runtime = stubWfGraphRuntime({
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
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const response = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "reconnect",
          integrationId: integration.id,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      attemptId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      authorizeUrl: expect.stringMatching(
        /^https:\/\/provider\.example\/authorize\?/
      ),
    });
    expect(attempt).toMatchObject({
      integrationId: integration.id,
      payload: {
        kind: "reconnect",
        configRevision: integration.configRevision,
      },
    });
  });

  it("persists a reserved integration id only after a successful create callback", async () => {
    let attempt: OAuthAuthorizationAttemptInput | undefined;
    let inserted:
      | Parameters<IntegrationRepo["Service"]["insertWithId"]>[0]
      | undefined;
    await using runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempt = input;
          }),
        claimOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            if (
              !attempt ||
              attempt.payload.kind !== "create" ||
              input.stateHash !== attempt.stateHash ||
              input.browserBindingHash !== attempt.browserBindingHash
            )
              return null;
            return {
              integrationId: null,
              payload: attempt.payload,
            } as const;
          }),
        completeOAuthCreateAttempt: (input) =>
          Effect.sync(() => {
            inserted = {
              id: input.integrationId,
              name: input.name,
              type: input.type,
              config: input.config,
            };
            return true;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const start = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          name: "Example connection",
          type: "example",
          config: { MANUAL_TOKEN: "manual" },
        }),
      })
    );
    const started = await start.json();
    expect(inserted).toBeUndefined();

    const state = started.attemptId;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const callback = await app.fetch(
      new Request(
        `http://localhost${basePath}/integrations/oauth/callback?state=${state}&code=provider-code`,
        { headers: { cookie } }
      )
    );

    expect(callback.status).toBe(200);
    expect(inserted).toMatchObject({
      id:
        attempt?.payload.kind === "create"
          ? attempt.payload.integrationId
          : undefined,
      name: "Example connection",
      type: "example",
      config: { MANUAL_TOKEN: "manual" },
    });
    expect(inserted?.config[OAUTH_GRANT_CONFIG_KEY]).toContain(
      "provider-token"
    );
  });

  it("refuses OAuth routes when the host has not configured a public URL", async () => {
    await using runtime = stubWfGraphRuntime({
      appContext: { apiBasePath: basePath },
      extensions: extensions(provider()),
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const response = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "reconnect", integrationId: "int_1" }),
      })
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("publishes only the metadata document outside the host auth gate", async () => {
    await using runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(defineWfGraphAuth(() => null)),
      runtime,
    });

    const metadata = await app.fetch(
      new Request(
        `http://localhost${basePath}/integrations/oauth/clients/example`
      )
    );
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    expect(await metadata.json()).toEqual({
      client_id: `${publicUrl}${basePath}/integrations/oauth/clients/example`,
      redirect_uris: [`${publicUrl}${basePath}/integrations/oauth/callback`],
    });
    const start = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "reconnect", integrationId: "int_1" }),
      })
    );
    expect(start.status).toBe(401);
    expect(start.headers.get("cache-control")).toBe("no-store");
    const createStart = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          name: "Example",
          type: "example",
          config: { ACCESS_TOKEN: "must-not-be-read" },
        }),
      })
    );
    expect(createStart.status).toBe(401);
    expect(createStart.headers.get("cache-control")).toBe("no-store");
    const status = await app.fetch(
      new Request(
        `http://localhost${basePath}/integrations/oauth/attempts/opaque`
      )
    );
    expect(status.status).toBe(401);
    const callback = await app.fetch(
      new Request(
        `http://localhost${basePath}/integrations/oauth/callback?state=opaque`
      )
    );
    expect(callback.status).toBe(401);
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("applies connection-write authorization to OAuth start, status, and callback", async () => {
    const seen: string[] = [];
    await using runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(
        defineWfGraphAuth(() => ({
          allows: (operation) => {
            seen.push(operation.id);
            return false;
          },
        }))
      ),
      runtime,
    });

    const start = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "reconnect", integrationId: "int_1" }),
      })
    );
    const status = await app.fetch(
      new Request(
        `http://localhost${basePath}/integrations/oauth/attempts/attempt_1`
      )
    );
    const callback = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/callback`)
    );

    expect([start.status, status.status, callback.status]).toEqual([
      403, 403, 403,
    ]);
    expect(seen).toEqual(["oauth.start", "oauth.status", "oauth.callback"]);
  });

  it.each([
    {
      name: "unknown fields",
      body: {
        mode: "create",
        name: "Example",
        type: "example",
        config: {},
        extra: true,
      },
    },
    {
      name: "the reserved grant key",
      body: {
        mode: "create",
        name: "Example",
        type: "example",
        config: { [OAUTH_GRANT_CONFIG_KEY]: "forged" },
      },
    },
    ...(["__proto__", "prototype", "constructor"] as const).map((key) => ({
      name: `the reserved config key ${key}`,
      body: {
        mode: "create",
        name: "Example",
        type: "example",
        config: Object.fromEntries([[key, "forged"]]),
      },
    })),
    {
      name: "non-string config values",
      body: {
        mode: "create",
        name: "Example",
        type: "example",
        config: { TOKEN: 42 },
      },
    },
    {
      name: "a combined create and reconnect shape",
      body: {
        mode: "reconnect",
        integrationId: "int_1",
        name: "Example",
      },
    },
    {
      name: "a missing mode",
      body: { name: "Example", type: "example", config: {} },
    },
  ])("rejects $name in a unified OAuth start request", async ({ body }) => {
    let attempted = false;
    await using runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        createOAuthAuthorizationAttempt: () =>
          Effect.sync(() => {
            attempted = true;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const response = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );

    expect(response.status).toBe(400);
    expect(attempted).toBe(false);
  });

  it("keeps the PKCE verifier in the attempt and uses its challenge in the redirect", async () => {
    let attempt: OAuthAuthorizationAttemptInput | undefined;
    await using runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempt = input;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const response = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          name: "Example",
          type: "example",
          config: {},
        }),
      })
    );
    const { authorizeUrl } = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(attempt?.payload.codeVerifier).toBeDefined();
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(attempt?.payload.codeVerifier ?? "")
    );
    const challenge = Buffer.from(digest).toString("base64url");
    expect(new URL(authorizeUrl).searchParams.get("challenge")).toBe(challenge);
  });

  it("returns browser-bound durable attempt statuses and clears the cookie only once terminal", async () => {
    let attempt: OAuthAuthorizationAttemptInput | undefined;
    let status: OAuthAuthorizationAttemptStatus = { status: "pending" };
    await using runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempt = input;
          }),
        readOAuthAuthorizationAttemptStatus: (input) =>
          Effect.succeed(
            input.stateHash === attempt?.stateHash &&
              input.browserBindingHash === attempt?.browserBindingHash
              ? status
              : null
          ),
      },
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const start = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          name: "Example",
          type: "example",
          config: {},
        }),
      })
    );
    const { attemptId } = await start.json();
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const url = `http://localhost${basePath}/integrations/oauth/attempts/${attemptId}`;

    const pending = await app.fetch(new Request(url, { headers: { cookie } }));
    expect(await pending.json()).toEqual({ status: "pending" });
    expect(pending.headers.get("set-cookie")).toBeNull();

    status = { status: "processing" };
    const processing = await app.fetch(
      new Request(url, { headers: { cookie } })
    );
    expect(await processing.json()).toEqual({ status: "pending" });
    expect(processing.headers.get("set-cookie")).toBeNull();

    status = { status: "succeeded", integrationId: integration.id };
    const succeeded = await app.fetch(
      new Request(url, { headers: { cookie } })
    );
    expect(await succeeded.json()).toEqual({
      status: "succeeded",
      integrationId: integration.id,
    });
    expect(succeeded.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(succeeded.headers.get("set-cookie")).toContain(
      `Path=${basePath}/integrations/oauth`
    );

    status = { status: "failed" };
    const failed = await app.fetch(new Request(url, { headers: { cookie } }));
    expect(await failed.json()).toEqual({ status: "failed" });
    expect(failed.headers.get("set-cookie")).toContain("Max-Age=0");

    const unbound = await app.fetch(
      new Request(url, {
        headers: { cookie: `wfgraph_oauth_${attemptId}=wrong-binding` },
      })
    );
    expect(unbound.status).toBe(404);
    expect(await unbound.text()).not.toContain("wrong-binding");
  });

  it("consumes a provider error callback without exchanging a code", async () => {
    let exchangeCalls = 0;
    let attempt: OAuthAuthorizationAttemptInput | undefined;
    let failed = false;
    await using runtime = stubWfGraphRuntime({
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
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempt = input;
          }),
        claimOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            if (
              input.stateHash !== attempt?.stateHash ||
              input.browserBindingHash !== attempt.browserBindingHash ||
              attempt?.payload.kind !== "create"
            ) {
              return null;
            }
            return { integrationId: null, payload: attempt.payload };
          }),
        failOAuthAuthorizationAttempt: () =>
          Effect.sync(() => {
            failed = true;
            return true;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const start = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          name: "Example",
          type: "example",
          config: {},
        }),
      })
    );
    const { attemptId } = await start.json();
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const callback = await app.fetch(
      new Request(
        `http://localhost${basePath}/integrations/oauth/callback?state=${attemptId}&error=access_denied`,
        { headers: { cookie } }
      )
    );
    expect(callback.status).toBe(400);
    expect(callback.headers.get("set-cookie")).toBeNull();
    expect(exchangeCalls).toBe(0);
    expect(failed).toBe(true);
    expect(await callback.text()).not.toContain("access_denied");
  });

  it("persists a private grant while the callback page omits provider values", async () => {
    let attempt: OAuthAuthorizationAttemptInput | undefined;
    let written: Record<string, string | undefined> | undefined;
    await using runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
      integrationRepo: {
        createOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            attempt = input;
          }),
        claimOAuthAuthorizationAttempt: (input) =>
          Effect.sync(() => {
            if (
              input.stateHash !== attempt?.stateHash ||
              input.browserBindingHash !== attempt.browserBindingHash ||
              attempt?.payload.kind !== "create"
            ) {
              return null;
            }
            return { integrationId: null, payload: attempt.payload };
          }),
        completeOAuthCreateAttempt: ({ config }) =>
          Effect.sync(() => {
            written = config;
            return true;
          }),
      },
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const start = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/oauth/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "create",
          name: "Example",
          type: "example",
          config: { MANUAL_TOKEN: "manual" },
        }),
      })
    );
    const { attemptId } = await start.json();
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const callback = await app.fetch(
      new Request(
        `http://localhost${basePath}/integrations/oauth/callback?state=${attemptId}&code=provider-code`,
        { headers: { cookie } }
      )
    );
    const page = await callback.text();
    expect(callback.status).toBe(200);
    expect(callback.headers.get("set-cookie")).toBeNull();
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(page).not.toContain("provider-token");
    expect(written?.MANUAL_TOKEN).toBe("manual");
    expect(written?.[OAUTH_GRANT_CONFIG_KEY]).toContain("provider-token");
  });

  it("does not expose OAuth disconnect as a direct API route", async () => {
    await using runtime = stubWfGraphRuntime({
      appContext: oauthAppContext,
      extensions: extensions(provider()),
    });
    const app = createApiApp({
      basePath,
      auth: resolveAuth(trustWfGraphUpstream()),
      runtime,
    });

    const response = await app.fetch(
      new Request(`http://localhost${basePath}/integrations/int_1/oauth`, {
        method: "DELETE",
      })
    );
    expect(response.status).toBe(404);
  });
});
