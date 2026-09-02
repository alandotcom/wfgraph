/**
 * PostHog's public OAuth client.
 *
 * Capture uses a project API key (`phc_`) in the JSON body of `/i/v0/e/`. OAuth
 * issues a Bearer access token (`pha_`) for the private REST API, so the adapter
 * exchanges the code, then reads the granted project's `api_token` and maps that
 * (plus the matching capture host) into the credentials the actions already
 * read. Refresh keeps those two values and only rotates the grant tokens.
 *
 * Token writes go through `oauth-cimd.ts`. What stays here is the authorize
 * URL, the token schema, and which project the grant is for.
 */

import type {
  IntegrationOAuth,
  OAuthGrant,
  OAuthPkceExchangeInput,
  OAuthRefreshInput,
  OAuthRevokeInput,
  OAuthTokenSet,
} from "@wfgraph/core/plugin";
import {
  callExternal,
  callExternalAsync,
  type ExternalError,
} from "@wfgraph/core/plugin";
import { Schema, SchemaTransformation } from "effect";
import {
  currentRefreshToken,
  emptyOAuthRevokeResponseSchema,
  requestCimdToken,
} from "#src/oauth-cimd";

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

type PostHogRegion = (typeof POSTHOG_REGIONS)[number];

const NonEmptyTrimmedString = Schema.String.pipe(
  Schema.decodeTo(Schema.String, SchemaTransformation.trim())
).check(Schema.isMinLength(1));

const posthogOAuthTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  refresh_token: Schema.String,
  scope: Schema.optionalKey(Schema.String),
  scoped_teams: Schema.optionalKey(Schema.Array(Schema.Finite)),
});

const posthogProjectSchema = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  api_token: NonEmptyTrimmedString,
});

const posthogProjectListSchema = Schema.Struct({
  results: Schema.Array(posthogProjectSchema),
});

type PostHogOAuthTokenResponse = typeof posthogOAuthTokenResponseSchema.Type;
type PostHogProject = typeof posthogProjectSchema.Type;

type ProjectCredentials = {
  readonly POSTHOG_PROJECT_API_KEY: string;
  readonly POSTHOG_HOST: string;
};

const NO_PROJECT = "PostHog OAuth could not find a project for this grant.";
const MANY_PROJECTS = "PostHog OAuth must be scoped to a single project.";
const NO_API_KEY = "PostHog did not return a project API key for this grant.";

function soleItem<T>(items: readonly T[]): T {
  if (items.length === 1) {
    const item = items[0];
    if (item !== undefined) {
      return item;
    }
  }

  if (items.length === 0) {
    throw new Error(NO_PROJECT);
  }

  throw new Error(MANY_PROJECTS);
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

function describeApiFailure(
  error: ExternalError,
  secrets: readonly string[]
): string {
  if (error._tag === "ExternalUnreadable" && error.status === 200) {
    return NO_API_KEY;
  }

  if (error._tag === "ExternalUnreachable") {
    return `PostHog API request failed: ${sanitize(error.message, secrets)}`;
  }

  return `PostHog API request failed: HTTP ${error.status}`;
}

/**
 * Probe the other cloud only when this one said the token is not for it.
 *
 * A GET is safe to repeat, so a 503 is retried against the same host. Treating
 * that, or a timeout, as a region miss would hide a 5xx from the right cloud
 * behind a second request to the wrong one.
 */
function shouldProbeNextRegion(error: ExternalError): boolean {
  return (
    error._tag === "ExternalRejected" &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

function requestPostHogToken<T extends Schema.ConstraintDecoder<unknown>>(
  url: string,
  body: URLSearchParams,
  schema: T,
  secrets: readonly string[]
): Promise<T["Type"]> {
  return requestCimdToken({
    system: "PostHog OAuth",
    url,
    body,
    schema,
    secrets,
  });
}

async function fetchProjectById(
  region: PostHogRegion,
  accessToken: string,
  projectId: number
): Promise<
  { ok: true; project: PostHogProject } | { ok: false; failure: ExternalError }
> {
  const result = await callExternalAsync(
    callExternal({
      system: "PostHog",
      url: `${region.apiHost}/api/projects/${projectId}/`,
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      schema: posthogProjectSchema,
    }),
    (error) => error
  );

  if (!result.ok) {
    return result;
  }

  return { ok: true, project: result.data };
}

async function fetchSoleListedProject(
  region: PostHogRegion,
  accessToken: string
): Promise<
  { ok: true; project: PostHogProject } | { ok: false; failure: ExternalError }
> {
  const result = await callExternalAsync(
    callExternal({
      system: "PostHog",
      url: `${region.apiHost}/api/projects/`,
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      schema: posthogProjectListSchema,
    }),
    (error) => error
  );

  if (!result.ok) {
    return result;
  }

  return { ok: true, project: soleItem(result.data.results) };
}

function credentialsFromProject(
  project: PostHogProject,
  captureHost: string
): { credentials: ProjectCredentials; accountLabel: string } {
  return {
    credentials: {
      POSTHOG_PROJECT_API_KEY: project.api_token,
      POSTHOG_HOST: captureHost,
    },
    accountLabel: project.name,
  };
}

/**
 * US first, then EU. Parallel would spend a request on the wrong cloud on
 * every grant, and a 5xx from the right cloud must not be hidden by trying
 * the other.
 */
async function resolveProject(
  accessToken: string,
  projectId: number | undefined,
  secrets: readonly string[]
): Promise<{ credentials: ProjectCredentials; accountLabel: string }> {
  const us = POSTHOG_REGIONS[0];
  const eu = POSTHOG_REGIONS[1];
  const fetch =
    projectId === undefined
      ? (region: PostHogRegion) => fetchSoleListedProject(region, accessToken)
      : (region: PostHogRegion) =>
          fetchProjectById(region, accessToken, projectId);

  const first = await fetch(us);

  if (first.ok) {
    return credentialsFromProject(first.project, us.captureHost);
  }

  if (!shouldProbeNextRegion(first.failure)) {
    throw new Error(describeApiFailure(first.failure, secrets));
  }

  const second = await fetch(eu);

  if (second.ok) {
    return credentialsFromProject(second.project, eu.captureHost);
  }

  throw new Error(describeApiFailure(second.failure, secrets));
}

function tokenSet(
  response: PostHogOAuthTokenResponse,
  credentials: ProjectCredentials,
  accountLabel?: string
): OAuthGrant {
  return {
    credentials,
    grantedAccessLabel: GRANTED_ACCESS_LABEL,
    accountLabel,
    tokens: {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: new Date(
        Date.now() + response.expires_in * 1000
      ).toISOString(),
    },
  };
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

/**
 * Empty `scoped_teams` means list and take the only project. One id means
 * fetch that project. More than one is the same refusal as a list of two.
 */
function projectIdFromGrant(
  scopedTeams: readonly number[] | undefined
): number | undefined {
  if (scopedTeams === undefined || scopedTeams.length === 0) {
    return undefined;
  }

  return soleItem(scopedTeams);
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
    const response = await requestPostHogToken(
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
      projectIdFromGrant(response.scoped_teams),
      [...secrets, response.access_token, response.refresh_token]
    );

    return tokenSet(response, project.credentials, project.accountLabel);
  },

  refresh: async ({
    client,
    grant,
  }: OAuthRefreshInput): Promise<OAuthTokenSet> => {
    const refreshToken = currentRefreshToken("PostHog", grant);
    const credentials = projectCredentialsFromGrant(grant);
    const response = await requestPostHogToken(
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
    const refreshToken = currentRefreshToken("PostHog", grant);
    await requestPostHogToken(
      POSTHOG_REVOKE_URL,
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
