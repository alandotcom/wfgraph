import type {
  IntegrationOAuth,
  JsonValue,
  OAuthClientRegistration,
  OAuthExchangeInput,
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
import { Schema } from "effect";

const SLACK_OAUTH_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_UNINSTALL_URL = "https://slack.com/api/apps.uninstall";

const slackEnvelopeSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});

const slackOAuthResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  access_token: Schema.String,
  expires_in: Schema.optionalKey(Schema.Finite),
  refresh_token: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String),
      })
    )
  ),
});

const slackOkResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
});

type SlackOAuthResponse = typeof slackOAuthResponseSchema.Type;

/**
 * Keep provider failures useful while keeping authorization material out of
 * messages. Slack's documented error values are lowercase identifier slugs.
 */
function readSafeSlackError(
  payload: JsonValue | undefined,
  sensitiveValues: readonly string[]
): string | undefined {
  const error = parsePayload(payload, slackEnvelopeSchema)?.error;
  if (error === undefined) {
    return undefined;
  }

  const errorCode = error.match(/^[a-z0-9_]{1,100}(?=$|:)/)?.[0];
  if (
    errorCode === undefined ||
    sensitiveValues.some((value) => value.length > 0 && errorCode === value)
  ) {
    return undefined;
  }

  return errorCode;
}

function describeOAuthFailure(
  error: ExternalError,
  sensitiveValues: readonly string[]
): string {
  if (error._tag === "ExternalUnreachable") {
    return `Slack OAuth request failed: ${redactSensitive(
      error.message,
      sensitiveValues
    )}`;
  }

  if (error._tag === "ExternalRejected") {
    const slackError = readSafeSlackError(error.payload, sensitiveValues);
    return slackError
      ? `Slack OAuth request rejected: ${slackError}`
      : `Slack OAuth request failed: HTTP ${error.status}`;
  }

  return `Slack OAuth request failed: HTTP ${error.status}`;
}

function redactSensitive(
  message: string,
  sensitiveValues: readonly string[]
): string {
  return sensitiveValues.reduce(
    (safeMessage, value) =>
      value.length === 0
        ? safeMessage
        : safeMessage.replaceAll(value, "[redacted]"),
    message
  );
}

function basicAuthorization(client: OAuthClientRegistration): string {
  return `Basic ${Buffer.from(
    `${client.clientId}:${client.clientSecret ?? ""}`
  ).toString("base64")}`;
}

async function requestSlackOAuth<S extends Schema.ConstraintDecoder<unknown>>(
  client: OAuthClientRegistration,
  url: string,
  body: URLSearchParams,
  schema: S,
  options: { basicAuth?: boolean } = {}
): Promise<S["Type"]> {
  const result = await callExternalAsync(
    callExternal({
      system: "Slack OAuth",
      url,
      method: "POST",
      headers:
        options.basicAuth === false
          ? {}
          : { authorization: basicAuthorization(client) },
      body: { kind: "form", value: body },
      schema,
      refusedInBody: (payload) =>
        parsePayload(payload, slackEnvelopeSchema)?.ok !== true,
    }),
    (error) => error
  );

  if (!result.ok) {
    throw new Error(
      describeOAuthFailure(result.failure, [
        client.clientSecret ?? "",
        ...body.values(),
      ])
    );
  }

  return result.data;
}

function tokenSet(
  response: SlackOAuthResponse,
  requireRefreshToken: boolean
): OAuthTokenSet {
  const hasExpiry = response.expires_in !== undefined;
  const hasRefreshToken = response.refresh_token !== undefined;

  if (requireRefreshToken && !hasRefreshToken) {
    throw new Error(
      "Slack OAuth refresh response must include a replacement refresh_token."
    );
  }

  if (hasExpiry !== hasRefreshToken) {
    throw new Error(
      "Slack OAuth token response must include both expires_in and refresh_token for token rotation."
    );
  }

  if (response.expires_in !== undefined && response.expires_in <= 0) {
    throw new Error("Slack OAuth token response has an invalid expires_in.");
  }

  return {
    credentials: { SLACK_API_KEY: response.access_token },
    tokens: {
      accessToken: response.access_token,
      ...(response.refresh_token === undefined
        ? {}
        : { refreshToken: response.refresh_token }),
      ...(response.expires_in === undefined
        ? {}
        : {
            expiresAt: new Date(
              Date.now() + response.expires_in * 1000
            ).toISOString(),
          }),
    },
  };
}

function createSlackOAuth(
  clientId: string,
  clientSecret: string
): IntegrationOAuth {
  const client: OAuthClientRegistration = { clientId, clientSecret };

  return {
    label: "Slack",

    registerClient: () => client,

    authorize: ({ redirectUri, state }) => {
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("scope", "chat:write");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url;
    },

    exchange: async ({ code, redirectUri }: OAuthExchangeInput) => {
      const response = await requestSlackOAuth(
        client,
        SLACK_OAUTH_URL,
        new URLSearchParams({ code, redirect_uri: redirectUri }),
        slackOAuthResponseSchema
      );
      const grant = tokenSet(response, false);
      return {
        ...grant,
        ...(response.team?.name ? { accountLabel: response.team.name } : {}),
      };
    },

    refresh: async ({ grant }: OAuthRefreshInput) => {
      const currentRefreshToken = grant.tokens.refreshToken;
      if (!currentRefreshToken) {
        throw new Error(
          "Slack OAuth refresh requires the current refresh_token."
        );
      }

      const response = await requestSlackOAuth(
        client,
        SLACK_OAUTH_URL,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: currentRefreshToken,
        }),
        slackOAuthResponseSchema
      );
      return tokenSet(response, true);
    },

    revoke: async ({ grant }: OAuthRevokeInput) => {
      await requestSlackOAuth(
        { clientId: client.clientId, clientSecret: undefined },
        SLACK_UNINSTALL_URL,
        new URLSearchParams({
          token: grant.tokens.accessToken,
          client_id: client.clientId,
          client_secret: client.clientSecret ?? "",
        }),
        slackOkResponseSchema,
        { basicAuth: false }
      );
    },
  };
}

export { createSlackOAuth };
