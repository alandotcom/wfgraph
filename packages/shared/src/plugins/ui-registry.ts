import { parseActionId } from "#src/extensions/catalog";

/**
 * The React half of an integration: its icon, and any custom renderer for a
 * step's output.
 *
 * Everything else about an integration reaches the editor as JSON over
 * `/api/extensions`. A component cannot be serialized, so this is the one thing
 * that stays an import: the browser bundle imports "@rova/plugins/ui", which
 * fills the map below, and a host defining its own integration writes its own
 * such module or settles for `logoUrl`. It is also why an integration's
 * definition never mentions its icon.
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

// A plain module map: one bundle holds it, because the only writer is the browser
// import above and the only readers are the components beside it.
const integrationUiRegistry = new Map<string, IntegrationUi>();

/**
 * Register a plugin's UI components. Called from the plugin's `ui.ts`, which
 * only the browser bundle imports.
 */
export function registerIntegrationUi(type: string, ui: IntegrationUi): void {
  integrationUiRegistry.set(type, ui);
}

/**
 * Get the UI components an integration registered. Returns undefined when the
 * integration has no plugin, or when the UI half was never imported (which is
 * the normal state on the server).
 */
export function getIntegrationUi(type: string): IntegrationUi | undefined {
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

  return parsed
    ? integrationUiRegistry.get(parsed.integration)?.outputComponents?.[
        parsed.slug
      ]
    : undefined;
}
