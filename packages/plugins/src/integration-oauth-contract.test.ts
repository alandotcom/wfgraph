import type {
  IntegrationOAuth,
  OAuthClientRegistration,
  OAuthGrant,
  OAuthTokenSet,
} from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";

const grant: OAuthGrant = {
  credentials: { MY_SERVICE_ACCESS_TOKEN: "access-token" },
  tokens: { accessToken: "access-token", refreshToken: "refresh-token" },
};

const refreshedTokens: OAuthTokenSet = {
  credentials: { MY_SERVICE_ACCESS_TOKEN: "replacement-access-token" },
  tokens: {
    accessToken: "replacement-access-token",
    refreshToken: "replacement-refresh-token",
  },
};

/** The registered confidential-client shape documented in integrations.md. */
const registeredClientOAuth = {
  label: "Registered client",
  registerClient: () => ({
    clientId: "registered-client-id",
    clientSecret: "registered-client-secret",
  }),
  authorize: ({ client, redirectUri, state }) => {
    const url = new URL("https://auth.example.com/authorize");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url;
  },
  exchange: async ({ client, code, redirectUri }) => {
    void client;
    void code;
    void redirectUri;
    return grant;
  },
  refresh: async () => refreshedTokens,
  revoke: async () => undefined,
} satisfies IntegrationOAuth;

/** The public metadata-client S256 shape documented in integrations.md. */
const publicMetadataClientOAuth = {
  label: "Public metadata client",
  pkce: "S256",
  registerClient: (context) => ({
    clientId: context.metadataDocumentUrl,
    metadataDocument: {
      client_id: context.metadataDocumentUrl,
      client_name: "Workflow Graph",
      client_uri: context.publicUrl,
      redirect_uris: [context.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "things:write",
    },
  }),
  authorize: ({ client, redirectUri, state, codeChallenge }) => {
    const url = new URL("https://auth.example.com/authorize");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  },
  exchange: async ({ codeVerifier }) => ({
    ...grant,
    accountLabel: codeVerifier,
  }),
  refresh: async () => refreshedTokens,
  revoke: async () => undefined,
} satisfies IntegrationOAuth;

function assertNonPkceInputsStayNarrow(
  authorize: Parameters<typeof registeredClientOAuth.authorize>[0],
  exchange: Parameters<typeof registeredClientOAuth.exchange>[0]
): void {
  // @ts-expect-error A registered non-PKCE client never receives a challenge.
  void authorize.codeChallenge;
  // @ts-expect-error A registered non-PKCE client never receives a verifier.
  void exchange.codeVerifier;
}

function assertPkceInputsStayRequired(
  authorize: Parameters<typeof publicMetadataClientOAuth.authorize>[0],
  exchange: Parameters<typeof publicMetadataClientOAuth.exchange>[0]
): void {
  const challenge: string = authorize.codeChallenge;
  const verifier: string = exchange.codeVerifier;
  void challenge;
  void verifier;
}

const metadataWithUnknownField = {
  clientId: "https://workflow.example.com/oauth/my-service-client.json",
  metadataDocument: {
    client_id: "https://workflow.example.com/oauth/my-service-client.json",
    // @ts-expect-error Public OAuth metadata has no arbitrary provider fields.
    provider_private_hint: "not public metadata",
  },
} satisfies OAuthClientRegistration;

describe("documented IntegrationOAuth contracts", () => {
  it("keeps the registered and PKCE examples as distinct public shapes", () => {
    expect(registeredClientOAuth).not.toHaveProperty("pkce");
    expect(publicMetadataClientOAuth.pkce).toBe("S256");
    expect(metadataWithUnknownField.clientId).toContain("oauth");
    expect(assertNonPkceInputsStayNarrow).toBeTypeOf("function");
    expect(assertPkceInputsStayRequired).toBeTypeOf("function");
  });
});
