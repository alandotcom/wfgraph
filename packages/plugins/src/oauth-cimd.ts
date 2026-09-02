/**
 * CIMD public-client token writes.
 *
 * Resend and PostHog both post form bodies to a metadata-document client with
 * no secret and no retry. The provider-specific mapping from a token response
 * to credentials stays in each adapter.
 */

import { compact } from "es-toolkit/array";
import type { JsonValue, OAuthGrant } from "@wfgraph/core/plugin";
import {
  callExternal,
  callExternalAsync,
  parsePayload,
  type ExternalError,
} from "@wfgraph/core/plugin";
import { Schema, SchemaTransformation } from "effect";

const oauthErrorSchema = Schema.Struct({
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
  error_uri: Schema.optionalKey(Schema.String),
});

/** A successful revocation has an empty 200 response body. */
export const emptyOAuthRevokeResponseSchema = Schema.Undefined.pipe(
  Schema.decodeTo(
    Schema.Literal(true),
    SchemaTransformation.transform({
      decode: (): true => true,
      encode: (): undefined => undefined,
    })
  )
);

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

function safeOAuthError(
  payload: JsonValue | undefined,
  secrets: readonly string[]
): string {
  const parsed = parsePayload(payload, oauthErrorSchema);
  const code = parsed?.error;
  const safeCode =
    code !== undefined && /^[a-z0-9_]{1,100}$/.test(code) ? code : undefined;
  const description = parsed?.error_description;
  const safeDescription = description
    ? sanitize(description, secrets).slice(0, 500)
    : undefined;

  return compact([safeCode, safeDescription]).join(": ") || "unknown error";
}

function describeOAuthFailure(
  system: string,
  error: ExternalError,
  secrets: readonly string[]
): string {
  if (error._tag === "ExternalUnreachable") {
    return `${system} request failed: ${sanitize(error.message, secrets)}`;
  }

  if (error._tag === "ExternalRejected") {
    return `${system} request rejected: ${safeOAuthError(error.payload, secrets)}`;
  }

  return `${system} request failed: HTTP ${error.status}`;
}

export async function requestCimdToken<
  T extends Schema.ConstraintDecoder<unknown>,
>(options: {
  readonly system: string;
  readonly url: string;
  readonly body: URLSearchParams;
  readonly schema: T;
  readonly secrets: readonly string[];
}): Promise<T["Type"]> {
  const result = await callExternalAsync(
    callExternal({
      system: options.system,
      url: options.url,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { kind: "form", value: options.body },
      schema: options.schema,
    }),
    (error) => error
  );

  if (!result.ok) {
    throw new Error(
      describeOAuthFailure(options.system, result.failure, options.secrets)
    );
  }

  return result.data;
}

export function currentRefreshToken(
  provider: string,
  grant: OAuthGrant
): string {
  const refreshToken = grant.tokens.refreshToken;
  if (!refreshToken) {
    throw new Error(
      `${provider} OAuth refresh requires the current refresh token`
    );
  }

  return refreshToken;
}
