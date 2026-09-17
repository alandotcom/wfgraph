/**
 * The payload an OAuth authorization attempt row stores, encrypted, from the
 * redirect to the provider until the callback, and the reader for its opened form.
 *
 * `readOAuthAuthorizationAttemptPayload` returns `null` for a payload that is not
 * JSON or matches neither kind, and a repository's claim then reports no attempt.
 */

import type { IntegrationConfig } from "@wfgraph/shared/types/integration";
import { readJsonObject } from "@wfgraph/shared/types/json";

type OAuthAuthorizationAttemptBase = {
  redirectUri: string;
  codeVerifier?: string | undefined;
};

export type OAuthReconnectAuthorizationAttemptPayload =
  OAuthAuthorizationAttemptBase & {
    kind: "reconnect";
    configRevision: number;
  };

export type OAuthCreateAuthorizationAttemptPayload =
  OAuthAuthorizationAttemptBase & {
    kind: "create";
    integrationId: string;
    configRevision: 0;
    name: string;
    type: string;
    config: IntegrationConfig;
  };

export type OAuthAuthorizationAttemptPayload =
  | OAuthReconnectAuthorizationAttemptPayload
  | OAuthCreateAuthorizationAttemptPayload;

export function readOAuthAuthorizationAttemptPayload(
  encryptedConfig: IntegrationConfig
): OAuthAuthorizationAttemptPayload | null {
  const serialized = encryptedConfig.payload;
  if (!serialized) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  const payload = readJsonObject(value);
  if (!payload) return null;
  const redirectUri = payload.redirectUri;
  const codeVerifier = payload.codeVerifier;
  if (
    typeof redirectUri !== "string" ||
    (codeVerifier !== undefined && typeof codeVerifier !== "string")
  ) {
    return null;
  }
  if (payload.kind === "reconnect") {
    const configRevision = payload.configRevision;
    if (
      typeof configRevision !== "number" ||
      !Number.isSafeInteger(configRevision) ||
      configRevision < 0
    )
      return null;
    return {
      kind: "reconnect",
      redirectUri,
      configRevision,
      codeVerifier,
    };
  }
  if (payload.kind !== "create") return null;
  const integrationId = payload.integrationId;
  const configRevision = payload.configRevision;
  const name = payload.name;
  const type = payload.type;
  const rawConfig = readJsonObject(payload.config);
  if (
    typeof integrationId !== "string" ||
    configRevision !== 0 ||
    typeof name !== "string" ||
    typeof type !== "string" ||
    !rawConfig
  ) {
    return null;
  }
  const config: IntegrationConfig = {};
  for (const [key, entry] of Object.entries(rawConfig)) {
    if (typeof entry !== "string") return null;
    config[key] = entry;
  }
  return {
    kind: "create",
    integrationId,
    configRevision,
    name,
    type,
    config,
    redirectUri,
    codeVerifier,
  };
}
