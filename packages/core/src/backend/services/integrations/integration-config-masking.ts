/**
 * Deciding what an integration's config may show the browser.
 *
 * Configs are stored encrypted and decrypted on read, so every value that leaves
 * this layer has already been unwrapped. What stands between a stored API token
 * and the editor is the masking below.
 */

import { getIntegration as getPluginFromRegistry } from "@rova/shared/plugins/registry";
import type {
  IntegrationConfig,
  IntegrationType,
} from "@rova/shared/types/integration";

export const SECRET_MASK = "********";

/**
 * Which config keys hold a secret, for an integration type.
 *
 * A plugin declares its secrets by marking form fields as passwords, so an
 * integration whose plugin is not registered has no declaration to read. That
 * happens whenever a host mounted Rova without `@rova/plugins`, or disabled a
 * plugin, and it used to answer "no secrets at all", which served a stored API
 * token to the browser in the clear. Not knowing which keys are secret is a
 * reason to treat every key as secret, so this answers a predicate and defaults
 * to true.
 */
export function createSecretConfigKeyTest(
  type: IntegrationType
): (key: string) => boolean {
  if (type === "database") {
    return (key) => key === "url";
  }

  const plugin = getPluginFromRegistry(type);
  if (!plugin) {
    return () => true;
  }

  const secretKeys = new Set(
    plugin.formFields
      .filter((field) => field.type === "password")
      .map((field) => field.configKey)
  );
  return (key) => secretKeys.has(key);
}

export function maskIntegrationConfig(
  type: IntegrationType,
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
