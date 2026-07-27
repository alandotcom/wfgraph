import { parseActionId } from "@/plugins/registry";
import { type IntegrationType, isIntegrationType } from "@/types/integration";

/**
 * Integration UI Registry
 *
 * The React half of a plugin: the integration's icon and any custom renderer
 * for a step's output. The other half is the plugin metadata in `registry.ts`,
 * which the backend imports to validate actions and to map credentials. Keeping
 * the two in separate modules means a plugin's `index.ts` holds plain data, so
 * the server graph terminates there and the published server bundle contains
 * server code alone. The browser bundle imports "@rova/plugins/ui", which fills
 * this registry in.
 */

/**
 * Result Component Props
 * Props passed to a custom output renderer.
 */
export type ResultComponentProps = {
  output: unknown;
  input?: unknown;
};

export type IntegrationUi = {
  // Rendered wherever the integration is identified: node badges, selectors,
  // connection dialogs.
  icon: React.ComponentType<{ className?: string }>;

  // Custom renderers for step output in the workflow runs panel, keyed by the
  // action slug the plugin declares in its `actions` list (for example
  // "get-user", matching the "clerk/get-user" action ID).
  outputComponents?: Record<string, React.ComponentType<ResultComponentProps>>;
};

// Keyed on globalThis with Symbol.for for the same reason as the plugin
// metadata registry: the module can be duplicated across bundles, and the
// registry has to stay a single shared Map when it is.
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- cross-bundle singleton via Symbol.for
const _g = globalThis as Record<symbol, unknown>;

const _uiKey = Symbol.for("@rova/integration-ui-registry");

if (!_g[_uiKey]) {
  _g[_uiKey] = new Map<IntegrationType, IntegrationUi>();
}

// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- initialized above
const integrationUiRegistry = _g[_uiKey] as Map<IntegrationType, IntegrationUi>;

/**
 * Register a plugin's UI components. Called from the plugin's `ui.ts`, which
 * only the browser bundle imports.
 */
export function registerIntegrationUi(
  type: IntegrationType,
  ui: IntegrationUi
): void {
  integrationUiRegistry.set(type, ui);
}

/**
 * Get the UI components an integration registered. Returns undefined when the
 * integration has no plugin, or when the UI half was never imported (which is
 * the normal state on the server).
 */
export function getIntegrationUi(type: string): IntegrationUi | undefined {
  if (!isIntegrationType(type)) {
    return undefined;
  }
  return integrationUiRegistry.get(type);
}

/**
 * Get the custom output renderer for a full action ID such as
 * "clerk/get-user". Returns undefined when the action displays its output as
 * plain JSON.
 */
export function getActionOutputComponent(
  actionId: string | undefined | null
): React.ComponentType<ResultComponentProps> | undefined {
  const parsed = parseActionId(actionId);
  if (!parsed || !isIntegrationType(parsed.integration)) {
    return undefined;
  }
  return integrationUiRegistry.get(parsed.integration)?.outputComponents?.[
    parsed.slug
  ];
}
