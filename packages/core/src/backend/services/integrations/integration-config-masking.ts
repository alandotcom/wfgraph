/**
 * Deciding what an integration's config may show the browser.
 *
 * Configs are stored encrypted and decrypted on read, so every value that leaves
 * this layer has already been unwrapped. What stands between a stored API token
 * and the editor is the masking below.
 */

import { getExtensions } from "#src/backend/lib/extensions/current";
import { findIntegration } from "@rova/shared/extensions/catalog";
import type { IntegrationConfig } from "@rova/shared/types/integration";

export const SECRET_MASK = "********";

/**
 * Which config keys hold a secret, for an integration type.
 *
 * An integration declares its secrets by marking credential fields as passwords,
 * so an integration the assembled catalog does not hold has no declaration to
 * read. That happens whenever a host mounted Rova without the integration a
 * stored row names, and it used to answer "no secrets at all", which served a
 * stored API token to the browser in the clear. Not knowing which keys are secret
 * is a reason to treat every key as secret, so this answers a predicate and
 * defaults to true.
 */
export function createSecretConfigKeyTest(
  type: string
): (key: string) => boolean {
  const integration = findIntegration(getExtensions().catalog, type);
  if (!integration) {
    return () => true;
  }

  const secretKeys = new Set(
    integration.credentialFields
      .filter((field) => field.type === "password")
      .map((field) => field.configKey)
  );
  return (key) => secretKeys.has(key);
}

export function maskIntegrationConfig(
  type: string,
  config: IntegrationConfig
): IntegrationConfig {
  const isSecretKey = createSecretConfigKeyTest(type);
  const maskedConfig: IntegrationConfig = { ...config };

  for (const key of Object.keys(maskedConfig)) {
    if (
      isSecretKey(key) &&
      typeof maskedConfig[key] === "string" &&
      maskedConfig[key]
    ) {
      maskedConfig[key] = SECRET_MASK;
    }
  }

  return maskedConfig;
}
