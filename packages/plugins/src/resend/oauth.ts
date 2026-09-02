/**
 * Resend's public OAuth client.
 *
 * Resend identifies a metadata-document client by its document URL. The adapter
 * keeps that URL in every provider request and sends all token material as form
 * data so the server can apply the same rules to exchange, refresh, and revoke.
 */

import { compact } from "es-toolkit/array";
import type {
  IntegrationOAuth,
  OAuthGrant,
  OAuthPkceExchangeInput,
  OAuthRefreshInput,
  OAuthRevokeInput,
  OAuthTokenSet,
} from "@wfgraph/core/plugin";
import { Schema } from "effect";
import {
  currentRefreshToken,
  emptyOAuthRevokeResponseSchema,
  requestCimdToken,
} from "#src/oauth-cimd";

const RESEND_AUTHORIZE_URL = "https://api.resend.com/oauth/authorize";
const RESEND_TOKEN_URL = "https://api.resend.com/oauth/token";
const RESEND_REVOKE_URL = "https://api.resend.com/oauth/revoke";

/**
 * Resend's whole scope vocabulary. There are two and nothing between them:
 * `emails:send` covers the send routes, `full_access` covers every other route,
 * which is why reading a template means asking for the account.
 *
 * The client registers both. The authorization then asks for neither by name,
 * because Resend's own consent page carries the Permission chooser and an
 * omitted `scope` requests the client's whole registered set. Naming one here
 * would only preselect it, and this app has no business deciding for an
 * operator looking at the page.
 */
const RESEND_SEND_SCOPE = "emails:send";
const RESEND_FULL_SCOPE = "full_access";

/**
 * What Resend granted, worded as its consent page words it, so an operator
 * recognizes the connection's access as the thing they just approved.
 *
 * A scope this cannot name answers nothing rather than throwing. The label is
 * what a dialog draws; the tokens beside it are what the connection runs on, and
 * a refresh that threw here would turn a working grant into one an operator has
 * to reauthorize over a word.
 */
function accessLabelFromScope(scope: string): string | undefined {
  const granted = new Set(compact(scope.split(/\s+/u)));
  if (granted.has(RESEND_FULL_SCOPE)) {
    return "Full access";
  }
  if (granted.has(RESEND_SEND_SCOPE)) {
    return "Sending access";
  }
  return undefined;
}

const resendOAuthTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  refresh_token: Schema.String,
  scope: Schema.String,
});

type ResendOAuthTokenResponse = typeof resendOAuthTokenResponseSchema.Type;

function tokenSet(response: ResendOAuthTokenResponse): OAuthTokenSet {
  const accessLabel = accessLabelFromScope(response.scope);
  return {
    credentials: { RESEND_API_KEY: response.access_token },
    // Both `exchange` and `refresh` build their answer here, so a refresh that
    // narrows the grant updates the stored access label with no further work.
    grantedAccessLabel: accessLabel,
    tokens: {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: new Date(
        Date.now() + response.expires_in * 1000
      ).toISOString(),
    },
  };
}

function requestResendToken<T extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  body: URLSearchParams,
  schema: T,
  secrets: readonly string[]
): Promise<T["Type"]> {
  return requestCimdToken({
    system: "Resend OAuth",
    url,
    body,
    schema,
    secrets,
  });
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
      scope: `${RESEND_SEND_SCOPE} ${RESEND_FULL_SCOPE}`,
    },
  }),

  authorize: ({ client, redirectUri, state, codeChallenge }) => {
    const url = new URL(RESEND_AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
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
    const response = await requestResendToken(
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
    const refreshToken = currentRefreshToken("Resend", grant);
    const response = await requestResendToken(
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
    const refreshToken = currentRefreshToken("Resend", grant);
    await requestResendToken(
      RESEND_REVOKE_URL,
      new URLSearchParams({
        client_id: client.clientId,
        token: refreshToken,
        token_type_hint: "refresh_token",
      }),
      emptyOAuthRevokeResponseSchema,
      [client.clientId, refreshToken, grant.tokens.accessToken]
    );
  },
};
