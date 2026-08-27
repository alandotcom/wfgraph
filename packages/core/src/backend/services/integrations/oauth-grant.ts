import { Result, Schema } from "effect";
import type { OAuthGrant } from "#src/backend/extensions/oauth";
import type { IntegrationConfig } from "@wfgraph/shared/types/integration";
export { OAUTH_GRANT_CONFIG_KEY } from "@wfgraph/shared/types/integration";
import { OAUTH_GRANT_CONFIG_KEY } from "@wfgraph/shared/types/integration";
import {
  NonEmptyTrimmedString,
  rejectUnknownKeys,
} from "@wfgraph/shared/types/schema";
import { isoTimestampString } from "@wfgraph/shared/types/timestamp";
import type { IntegrationMetadata } from "@wfgraph/shared/extensions/catalog";

export type StoredOAuthGrant = OAuthGrant & {
  readonly connectedAt: string;
};

const oauthTokensSchema = Schema.Struct({
  accessToken: NonEmptyTrimmedString,
  refreshToken: Schema.optionalKey(NonEmptyTrimmedString),
  expiresAt: Schema.optionalKey(isoTimestampString()),
});

const storedOAuthGrantSchema = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Record(Schema.String, NonEmptyTrimmedString),
  tokens: oauthTokensSchema,
  connectedAt: isoTimestampString(),
  accountLabel: Schema.optionalKey(NonEmptyTrimmedString),
  /**
   * How much access the provider granted, in its own words. It must be named
   * here because `decodeGrant` rejects unknown keys, so an adapter reporting one
   * against a schema that has never heard of it would answer as a damaged grant
   * and refuse the whole callback.
   */
  grantedAccessLabel: Schema.optionalKey(NonEmptyTrimmedString),
});

const decodeGrant = Schema.decodeUnknownResult(
  storedOAuthGrantSchema,
  rejectUnknownKeys
);

function readGrant(value: unknown): StoredOAuthGrant | null {
  const decoded = decodeGrant(value);
  if (Result.isFailure(decoded) || decoded.success.version !== 1) {
    return null;
  }

  const { version: _, ...grant } = decoded.success;
  return grant;
}

/**
 * Read the one private config member that carries an OAuth grant.
 *
 * The encrypted envelope is durable data rather than a trusted object. A damaged
 * or old value therefore answers as absent and cannot expose a partial grant.
 */
export function readStoredOAuthGrant(
  config: IntegrationConfig
): StoredOAuthGrant | null {
  const encoded = config[OAUTH_GRANT_CONFIG_KEY];
  if (!encoded) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }

  return readGrant(parsed);
}

/** Encode a checked grant as the versioned JSON value sealed by IntegrationRepo. */
export function serializeStoredOAuthGrant(grant: StoredOAuthGrant): string {
  return JSON.stringify({ version: 1, ...grant });
}

/**
 * Validate a provider result before it is committed to the encrypted envelope.
 *
 * Provider adapters are extension code and their TypeScript declaration cannot
 * prove the runtime result. Decoding it here makes an invalid result a refused
 * callback rather than a credential bag an action discovers later.
 */
export function normalizeOAuthGrant(
  grant: OAuthGrant,
  connectedAt: string
): StoredOAuthGrant | null {
  return readGrant({ version: 1, ...grant, connectedAt });
}

/** Check every OAuth override against the integration's declared vocabulary. */
export function oauthCredentialsAreDeclared(
  integration: IntegrationMetadata,
  credentials: Readonly<Record<string, string>>
): boolean {
  return Object.keys(credentials).every((key) =>
    Object.hasOwn(integration.credentialFields, key)
  );
}

/**
 * Remove OAuth's private entry while retaining every operator-entered setting.
 *
 * A manual credential stored under a key the grant also filled is kept on
 * purpose: disconnecting is what an operator reaches for when OAuth has failed
 * them, and it is the one path back to the key they typed in themselves.
 */
export function removeStoredOAuthGrant(
  config: IntegrationConfig
): IntegrationConfig {
  const { [OAUTH_GRANT_CONFIG_KEY]: _, ...manualConfig } = config;
  return manualConfig;
}
