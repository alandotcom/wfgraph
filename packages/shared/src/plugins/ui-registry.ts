import type { ActionMetadata } from "#src/extensions/catalog";

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
 * The custom output renderer for an action, or undefined when its output is
 * shown as plain JSON.
 *
 * Which integration owns an action is the catalog's answer, not the id's. A host
 * writes whatever id it likes -- `createAction({ id: "slack/notify" })` is a
 * legal id belonging to no integration -- so reading the owner off the string
 * would hand that action Slack's renderer for output Slack knows nothing about.
 * The slug is the other half of the id assembly built with `formatActionId`.
 */
export function getActionOutputComponent(
  action: ActionMetadata | undefined
): React.ComponentType<ResultComponentProps> | undefined {
  const owner = action?.integration;
  if (!owner) {
    return undefined;
  }

  const prefix = `${owner}/`;
  if (!action.id.startsWith(prefix)) {
    return undefined;
  }

  return integrationUiRegistry.get(owner)?.outputComponents?.[
    action.id.slice(prefix.length)
  ];
}
