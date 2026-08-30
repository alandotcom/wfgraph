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
  getOAuthClientMetadata,
  oauthBindingCookieName,
  readIntegrationOAuthAttemptStatus,
  startIntegrationOAuth,
} from "#src/backend/services/integrations/oauth";
import { makeAppContextLayer } from "#src/backend/lib/effect/app-context";
import { emptyExtensionCatalog } from "@wfgraph/shared/extensions/catalog";
import {
  InternalFailure,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import { appContext } from "#src/backend/services/integrations/oauth.test-support";

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
                    hasWebhook: false,
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
                    hasWebhook: false,
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
            hasWebhook: false,
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

describe("OAuth create config", () => {
  it.each(["__proto__", "prototype", "constructor"])(
    "rejects the reserved key %s at the service boundary",
    async (key) => {
      const result = await Effect.runPromise(
        Effect.result(
          startIntegrationOAuth({
            mode: "create",
            name: "Example",
            type: "example",
            config: Object.fromEntries([[key, "forged"]]),
          })
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              SilentAppLoggerLayer,
              appContext,
              stubExtensions({ catalog: emptyExtensionCatalog }),
              stubIntegrationRepo()
            )
          )
        )
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(InvalidInput);
      }
    }
  );
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
