/**
 * PostHog's public OAuth client.
 *
 * Capture uses a project API key (`phc_`) in the JSON body of `/i/v0/e/`. OAuth
 * issues a Bearer access token (`pha_`) for the private REST API, so the adapter
 * exchanges the code, then reads the granted project's `api_token` and maps that
 * (plus the matching capture host) into the credentials the actions already
 * read. Refresh keeps those two values and only rotates the grant tokens.
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

const POSTHOG_AUTHORIZE_URL = "https://oauth.posthog.com/oauth/authorize/";
const POSTHOG_TOKEN_URL = "https://oauth.posthog.com/oauth/token/";
const POSTHOG_REVOKE_URL = "https://oauth.posthog.com/oauth/revoke/";

/**
 * The only scope capture needs from the private API: reading the project so
 * the adapter can copy its `api_token`. Naming none would request PostHog's
 * entire vocabulary, and PostHog's consent page has no permission chooser that
 * would narrow that for us.
 */
const POSTHOG_PROJECT_READ_SCOPE = "project:read";

const GRANTED_ACCESS_LABEL = "Project access";

const POSTHOG_REGIONS = [
  {
    apiHost: "https://us.posthog.com",
    captureHost: "https://us.i.posthog.com",
  },
  {
    apiHost: "https://eu.posthog.com",
    captureHost: "https://eu.i.posthog.com",
  },
] as const;

const posthogOAuthTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  refresh_token: Schema.String,
  scope: Schema.optionalKey(Schema.String),
  scoped_teams: Schema.optionalKey(Schema.Array(Schema.Finite)),
});

const posthogOAuthErrorSchema = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
  error_uri: Schema.optionalKey(Schema.String),
});

const posthogProjectSchema = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  api_token: Schema.optionalKey(Schema.String),
});

const posthogProjectListSchema = Schema.Struct({
  results: Schema.Array(posthogProjectSchema),
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

type PostHogOAuthTokenResponse = typeof posthogOAuthTokenResponseSchema.Type;
type PostHogProject = typeof posthogProjectSchema.Type;

type ProjectCredentials = {
  readonly POSTHOG_PROJECT_API_KEY: string;
  readonly POSTHOG_HOST: string;
};

function safeOAuthError(
  payload: JsonValue | undefined,
  secrets: readonly string[]
): string {
  const parsed = parsePayload(payload, posthogOAuthErrorSchema);
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
    return `PostHog OAuth request failed: ${sanitize(error.message, secrets)}`;
  }

  if (error._tag === "ExternalRejected") {
    return `PostHog OAuth request rejected: ${safeOAuthError(error.payload, secrets)}`;
  }

  return `PostHog OAuth request failed: HTTP ${error.status}`;
}

function describeApiFailure(
  error: ExternalError,
  secrets: readonly string[]
): string {
  if (error._tag === "ExternalUnreachable") {
    return `PostHog API request failed: ${sanitize(error.message, secrets)}`;
  }

  if (error._tag === "ExternalRejected") {
    return `PostHog API request rejected: HTTP ${error.status}`;
  }

  return `PostHog API request failed: HTTP ${error.status}`;
}

function isWrongRegion(error: ExternalError): boolean {
  if (error._tag === "ExternalUnreachable") {
    return true;
  }

  if (error._tag !== "ExternalRejected") {
    return false;
  }

  return error.status === 401 || error.status === 403 || error.status === 404;
}

async function requestOAuth<T extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  body: URLSearchParams,
  schema: T,
  secrets: readonly string[]
): Promise<T["Type"]> {
  const result = await callExternalAsync(
    callExternal({
      system: "PostHog OAuth",
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

async function requestApi<T extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  accessToken: string,
  schema: T
): Promise<
  { ok: true; data: T["Type"] } | { ok: false; failure: ExternalError }
> {
  const result = await callExternalAsync(
    callExternal({
      system: "PostHog",
      url,
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      schema,
    }),
    (error) => error
  );

  if (!result.ok) {
    return { ok: false, failure: result.failure };
  }

  return { ok: true, data: result.data };
}

function projectFromList(projects: readonly PostHogProject[]): PostHogProject {
  if (projects.length === 0) {
    throw new Error("PostHog OAuth could not find a project for this grant.");
  }

  if (projects.length > 1) {
    throw new Error("PostHog OAuth must be scoped to a single project.");
  }

  const project = projects[0];
  if (!project) {
    throw new Error("PostHog OAuth could not find a project for this grant.");
  }

  return project;
}

function credentialsFromProject(
  project: PostHogProject,
  captureHost: string
): { credentials: ProjectCredentials; accountLabel: string } {
  const apiToken = project.api_token?.trim();
  if (!apiToken) {
    throw new Error("PostHog did not return a project API key for this grant.");
  }

  return {
    credentials: {
      POSTHOG_PROJECT_API_KEY: apiToken,
      POSTHOG_HOST: captureHost,
    },
    accountLabel: project.name,
  };
}

async function resolveProject(
  accessToken: string,
  projectId: number | undefined,
  secrets: readonly string[]
): Promise<{ credentials: ProjectCredentials; accountLabel: string }> {
  let lastFailure: string | undefined;

  for (const region of POSTHOG_REGIONS) {
    const url =
      projectId === undefined
        ? `${region.apiHost}/api/projects/`
        : `${region.apiHost}/api/projects/${projectId}/`;
    const result =
      projectId === undefined
        ? await requestApi(url, accessToken, posthogProjectListSchema)
        : await requestApi(url, accessToken, posthogProjectSchema);

    if (!result.ok) {
      lastFailure = describeApiFailure(result.failure, secrets);
      if (isWrongRegion(result.failure)) {
        continue;
      }

      throw new Error(lastFailure);
    }

    const project =
      "results" in result.data
        ? projectFromList(result.data.results)
        : result.data;

    return credentialsFromProject(project, region.captureHost);
  }

  throw new Error(
    lastFailure ?? "PostHog OAuth could not find a project for this grant."
  );
}

function tokenSet(
  response: PostHogOAuthTokenResponse,
  credentials: ProjectCredentials,
  accountLabel?: string
): OAuthGrant {
  return {
    credentials,
    grantedAccessLabel: GRANTED_ACCESS_LABEL,
    ...(accountLabel ? { accountLabel } : {}),
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
    throw new Error("PostHog OAuth refresh requires the current refresh token");
  }

  return refreshToken;
}

function projectCredentialsFromGrant(grant: OAuthGrant): ProjectCredentials {
  const projectApiKey = grant.credentials.POSTHOG_PROJECT_API_KEY;
  const host = grant.credentials.POSTHOG_HOST;
  if (!(projectApiKey && host)) {
    throw new Error(
      "PostHog OAuth refresh requires the stored project API key and host."
    );
  }

  return {
    POSTHOG_PROJECT_API_KEY: projectApiKey,
    POSTHOG_HOST: host,
  };
}

function scopedProjectId(
  scopedTeams: readonly number[] | undefined
): number | undefined {
  const projectId = scopedTeams?.[0];
  return typeof projectId === "number" ? projectId : undefined;
}

export const posthogOAuth: IntegrationOAuth = {
  label: "PostHog",
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
      scope: POSTHOG_PROJECT_READ_SCOPE,
    },
  }),

  authorize: ({ client, redirectUri, state, codeChallenge }) => {
    const url = new URL(POSTHOG_AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", POSTHOG_PROJECT_READ_SCOPE);
    url.searchParams.set("required_access_level", "project");
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
    const secrets = [client.clientId, code, codeVerifier];
    const response = await requestOAuth(
      POSTHOG_TOKEN_URL,
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
      posthogOAuthTokenResponseSchema,
      secrets
    );

    const project = await resolveProject(
      response.access_token,
      scopedProjectId(response.scoped_teams),
      [...secrets, response.access_token, response.refresh_token]
    );

    return tokenSet(response, project.credentials, project.accountLabel);
  },

  refresh: async ({
    client,
    grant,
  }: OAuthRefreshInput): Promise<OAuthTokenSet> => {
    const refreshToken = currentRefreshToken(grant);
    const credentials = projectCredentialsFromGrant(grant);
    const response = await requestOAuth(
      POSTHOG_TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.clientId,
        refresh_token: refreshToken,
      }),
      posthogOAuthTokenResponseSchema,
      [client.clientId, refreshToken, grant.tokens.accessToken]
    );

    return tokenSet(response, credentials);
  },

  revoke: async ({ client, grant }: OAuthRevokeInput): Promise<void> => {
    const refreshToken = currentRefreshToken(grant);
    await requestOAuth(
      POSTHOG_REVOKE_URL,
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
