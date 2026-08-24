/**
 * Resend's public OAuth client.
 *
 * Resend identifies a metadata-document client by its document URL. The adapter
 * keeps that URL in every provider request and sends all token material as form
 * data so the server can apply the same rules to exchange, refresh, and revoke.
 */

import type {
  IntegrationOAuth,
  JsonValue,
  OAuthGrant,
  OAuthPkceExchangeInput,
  OAuthRefreshInput,
  OAuthRevokeInput,
  OAuthTokenSet,
} from "@wfgraph/core/plugin";
import {
  callExternal,
  callExternalAsync,
  parsePayload,
  type ExternalError,
} from "@wfgraph/core/plugin";
import { Schema, SchemaTransformation } from "effect";

const RESEND_AUTHORIZE_URL = "https://api.resend.com/oauth/authorize";
const RESEND_TOKEN_URL = "https://api.resend.com/oauth/token";
const RESEND_REVOKE_URL = "https://api.resend.com/oauth/revoke";
const RESEND_SCOPE = "emails:send";

const resendOAuthTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  refresh_token: Schema.String,
  scope: Schema.String,
});

const resendOAuthErrorSchema = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
  error_uri: Schema.optionalKey(Schema.String),
});

/** A successful revocation has an empty 200 response body. */
const emptyOAuthResponseSchema = Schema.Undefined.pipe(
  Schema.decodeTo(
    Schema.Literal(true),
    SchemaTransformation.transform({
      decode: (): true => true,
      encode: (): undefined => undefined,
    })
  )
);

type ResendOAuthTokenResponse = typeof resendOAuthTokenResponseSchema.Type;

function safeOAuthError(
  payload: JsonValue | undefined,
  secrets: readonly string[]
): string {
  const parsed = parsePayload(payload, resendOAuthErrorSchema);
  const code = parsed?.error;
  const safeCode =
    code !== undefined && /^[a-z0-9_]{1,100}$/.test(code) ? code : undefined;
  const description = parsed?.error_description;
  const safeDescription = description
    ? sanitize(description, secrets).slice(0, 500)
    : undefined;

  return (
    [safeCode, safeDescription].filter(Boolean).join(": ") || "unknown error"
  );
}

function sanitize(value: string, secrets: readonly string[]): string {
  let sanitized = value;

  for (const secret of secrets) {
    if (secret.length === 0) {
      continue;
    }

    sanitized = sanitized
      .replaceAll(secret, "[redacted]")
      .replaceAll(encodeURIComponent(secret), "[redacted]");
  }

  return sanitized;
}

function describeOAuthFailure(
  error: ExternalError,
  secrets: readonly string[]
): string {
  if (error._tag === "ExternalUnreachable") {
    return `Resend OAuth request failed: ${sanitize(error.message, secrets)}`;
  }

  if (error._tag === "ExternalRejected") {
    return `Resend OAuth request rejected: ${safeOAuthError(error.payload, secrets)}`;
  }

  return `Resend OAuth request failed: HTTP ${error.status}`;
}

async function requestOAuth<T extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  body: URLSearchParams,
  schema: T,
  secrets: readonly string[]
): Promise<T["Type"]> {
  const result = await callExternalAsync(
    callExternal({
      system: "Resend OAuth",
      url,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { kind: "form", value: body },
      schema,
    }),
    (error) => error
  );

  if (!result.ok) {
    throw new Error(describeOAuthFailure(result.failure, secrets));
  }

  return result.data;
}

function tokenSet(response: ResendOAuthTokenResponse): OAuthTokenSet {
  return {
    credentials: { RESEND_API_KEY: response.access_token },
    tokens: {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: new Date(
        Date.now() + response.expires_in * 1000
      ).toISOString(),
    },
  };
}

function currentRefreshToken(grant: OAuthGrant): string {
  const refreshToken = grant.tokens.refreshToken;
  if (!refreshToken) {
    throw new Error("Resend OAuth refresh requires the current refresh token");
  }

  return refreshToken;
}

export const resendOAuth: IntegrationOAuth = {
  label: "Resend",
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
      scope: RESEND_SCOPE,
    },
  }),

  authorize: ({ client, redirectUri, state, codeChallenge }) => {
    const url = new URL(RESEND_AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", RESEND_SCOPE);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  },

  exchange: async ({
    client,
    code,
    redirectUri,
    codeVerifier,
  }: OAuthPkceExchangeInput): Promise<OAuthGrant> => {
    const response = await requestOAuth(
      RESEND_TOKEN_URL,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
      resendOAuthTokenResponseSchema,
      [client.clientId, code, codeVerifier]
    );

    return tokenSet(response);
  },

  refresh: async ({
    client,
    grant,
  }: OAuthRefreshInput): Promise<OAuthTokenSet> => {
    const refreshToken = currentRefreshToken(grant);
    const response = await requestOAuth(
      RESEND_TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: refreshToken,
      }),
      resendOAuthTokenResponseSchema,
      [client.clientId, refreshToken, grant.tokens.accessToken]
    );

    return tokenSet(response);
  },

  revoke: async ({ client, grant }: OAuthRevokeInput): Promise<void> => {
    const refreshToken = currentRefreshToken(grant);
    await requestOAuth(
      RESEND_REVOKE_URL,
      new URLSearchParams({
        client_id: client.clientId,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
      emptyOAuthResponseSchema,
      [client.clientId, refreshToken, grant.tokens.accessToken]
    );
  },
};
