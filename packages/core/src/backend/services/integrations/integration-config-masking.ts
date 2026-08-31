/**
 * Deciding what an integration's config may show the browser.
 *
 * Configs are stored encrypted and decrypted on read, so every value that leaves
 * this layer has already been unwrapped. What stands between a stored API token
 * and the editor is the masking below.
 */

import {
  type ExtensionCatalog,
  fieldsForIntegration,
  findIntegration,
} from "@wfgraph/shared/extensions/catalog";
import type { IntegrationConfig } from "@wfgraph/shared/types/integration";

export const SECRET_MASK = "********";

/**
 * Which config keys hold a secret, for an integration type.
 *
 * An integration declares its secrets by marking credential fields as passwords,
 * so an integration the assembled catalog does not hold has no declaration to
 * read. That happens whenever a host mounted Workflow Graph without the integration a
 * stored row names, and answering "no secrets at all" there would serve a
 * stored API token to the browser in the clear. Not knowing which keys are secret
 * is a reason to treat every key as secret, so this answers a predicate and
 * defaults to true.
 */
export function createSecretConfigKeyTest(
  catalog: ExtensionCatalog,
  type: string
): (key: string) => boolean {
  const integration = findIntegration(catalog, type);
  if (!integration) {
    return () => true;
  }

  // Named from the other side on purpose: a key the integration does not declare
  // is secret. A stored row outliving a rename would otherwise be served in the
  // clear, which is the same reason an integration the catalog never heard of
  // masks everything above.
  const plainKeys = new Set(
    Object.entries(integration.credentialFields)
      .filter(([, field]) => field.type !== "password")
      .map(([key]) => key)
  );
  return (key) => !plainKeys.has(key);
}

export function maskIntegrationConfig(
  catalog: ExtensionCatalog,
  type: string,
  config: IntegrationConfig
): IntegrationConfig {
  const isSecretKey = createSecretConfigKeyTest(catalog, type);
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

/**
 * The Connection values the editor may draw as a config field's placeholder.
 *
 * A field says which Connection value it falls back to with
 * `connectionDefaultKey`, and that declaration is the whole allowlist: a stored
 * value no field names never reaches the browser, however harmless it looks.
 *
 * The secret test below cannot fire in an assembled app, because
 * `checkIntegration` already refused a password key against the same
 * declaration this catalog was built from. It is kept as the last gate before a
 * value leaves the process, where one `&&` is cheaper than the failure it
 * guards.
 */
export function connectionDefaultsForBrowser(
  catalog: ExtensionCatalog,
  type: string,
  config: IntegrationConfig
): Record<string, string> {
  // Fail-closed for free: an integration the catalog does not hold contributes
  // no fields to walk, so this answers the empty record without a case of its
  // own.
  const isSecretKey = createSecretConfigKeyTest(catalog, type);
  const defaults: Record<string, string> = {};

  for (const field of fieldsForIntegration(catalog, type)) {
    const key = field.connectionDefaultKey;
    if (!key || isSecretKey(key)) {
      continue;
    }

    const value = config[key];
    if (typeof value === "string" && value) {
      defaults[key] = value;
    }
  }

  return defaults;
}
