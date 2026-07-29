import {
  type IntegrationType,
  isIntegrationType,
} from "#src/types/integration";
import {
  getRuntimeActionRegistryVersion,
  getRuntimeActions,
} from "#src/workflow/action-registry";
import type { ReferenceField } from "#src/workflow/node-references";
import {
  type OutputSchema,
  requireOutputFieldsFromSchema,
} from "#src/workflow/output-fields";

/**
 * Select Option
 * Used for select/dropdown fields
 */
export type SelectOption = {
  value: string;
  label: string;
};

/**
 * Base Action Config Field
 * Declarative definition of a config field for an action
 */
export type ActionConfigFieldBase = {
  // Unique key for this field in the config object
  key: string;

  // Human-readable label
  label: string;

  // Field type
  type:
    | "template-input" // TemplateBadgeInput - supports {{variable}}
    | "template-textarea" // TemplateBadgeTextarea - supports {{variable}}
    | "text" // Regular text input
    | "number" // Number input
    | "select" // Dropdown select
    | "schema-builder" // Schema builder for structured output
    | "key-value"; // Dynamic key-value pair list

  // Placeholder text
  placeholder?: string;

  // Default value
  defaultValue?: string;

  // Example value for AI prompt generation
  example?: string;

  // For select fields: list of options
  options?: SelectOption[];

  // Number of rows (for textarea)
  rows?: number;

  // Min value (for number fields)
  min?: number;

  // Whether this field is required (defaults to false)
  required?: boolean;

  // Conditional rendering: only show if another field has a specific value
  showWhen?: {
    field: string;
    equals: string;
  };
};

/**
 * Config Field Group
 * Groups related fields together in a collapsible section
 */
export type ActionConfigFieldGroup = {
  // Human-readable label for the group
  label: string;

  // Field type (always "group" for groups)
  type: "group";

  // Nested fields within this group
  fields: ActionConfigFieldBase[];

  // Whether the group is expanded by default (defaults to false)
  defaultExpanded?: boolean;
};

/**
 * Action Config Field
 * Can be either a regular field or a group of fields
 */
export type ActionConfigField = ActionConfigFieldBase | ActionConfigFieldGroup;

/**
 * Output Display Config
 * Specifies how to render step output in the workflow runs panel.
 *
 * This is plain data, so the backend can import plugin metadata freely. A
 * plugin that renders its output with a React component declares that component
 * in `ui-registry.ts`.
 */
export type OutputDisplayConfig = {
  // Built-in display types
  type: "image" | "video" | "url";
  // Field name in the step output that contains the displayable value
  field: string;
};

/**
 * Action Definition
 * Describes a single action provided by a plugin
 */
export type PluginAction = {
  // Unique slug for this action (e.g., "send-email")
  // Full action ID will be computed as `{integration}/{slug}` (e.g., "resend/send-email")
  slug: string;

  // Human-readable label (e.g., "Send Email")
  label: string;

  // Description of what this action does
  description: string;

  // Category for grouping in UI
  category: string;

  // Config fields for the action (declarative definition)
  configFields: ActionConfigField[];

  /**
   * What the action's step returns, as a schema.
   *
   * The step's handler is typed against this same schema, so a step whose
   * output drifts from what the editor offers downstream stops compiling. The
   * template-autocomplete list is derived from it at registration; paths omit
   * the `data.` prefix, because the schema describes the payload rather than
   * the `StepResult` wrapper around it.
   */
  output?: OutputSchema<unknown>;

  /**
   * The same list, written by hand.
   *
   * Every plugin action still carrying one is a step that has not moved to
   * `defineStep` yet; stage 6b of ADR-0002 is where the last of them goes and
   * this field with it. An action may declare one or the other, never both.
   */
  outputFields?: ReferenceField[];

  // Output display configuration (how to render output in workflow runs panel)
  outputConfig?: OutputDisplayConfig;
};

/**
 * An action as the registry holds it: the schema has been read and what it said
 * is in `outputFields`.
 *
 * Nothing downstream of registration sees an `output` schema. The browser holds
 * this registry, and a schema object there is a dump of one library's internals
 * that no reader has a use for.
 */
export type RegisteredPluginAction = Omit<PluginAction, "output">;

/**
 * Integration Plugin Definition
 * Everything the backend and the editor need to know about an integration,
 * as plain data. The integration's icon is registered separately in
 * `ui-registry.ts`, which only the browser bundle imports.
 */
export type IntegrationPlugin = {
  // Basic info
  type: IntegrationType;
  label: string;
  description: string;

  // Form fields for the integration dialog
  formFields: Array<{
    id: string;
    label: string;
    type: "text" | "password" | "url";
    placeholder?: string;
    helpText?: string;
    helpLink?: { text: string; url: string };
    configKey: string; // Which key in IntegrationConfig to store the value
    envVar?: string; // Environment variable this field maps to (e.g., "RESEND_API_KEY")
  }>;

  // Avoid using this field. Plugins should use fetch instead of SDK dependencies
  // to reduce supply chain attack surface. Only use for codegen if absolutely necessary.
  dependencies?: Record<string, string>;

  // Actions provided by this integration
  actions: PluginAction[];
};

/** An integration as the registry holds it, with every action's schema read. */
export type RegisteredIntegrationPlugin = Omit<IntegrationPlugin, "actions"> & {
  actions: RegisteredPluginAction[];
};

/**
 * Action with full ID
 * Includes the computed full action ID (integration/slug)
 */
export type ActionWithFullId = RegisteredPluginAction & {
  id: string; // Full action ID: {integration}/{slug}
  integration?: string;
  logoUrl?: string;
};

/**
 * Integration Registry
 * Auto-populated by plugin files
 *
 * Uses Symbol.for keys on globalThis so the registries remain true singletons
 * even when this module is duplicated across bundles (e.g. the @rova/core
 * library build inlines @rova/shared while @rova/plugins imports it separately).
 */
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- cross-bundle singleton via Symbol.for
const _g = globalThis as Record<symbol, unknown>;

const _intKey = Symbol.for("@rova/integration-registry");
const _cacheKey = Symbol.for("@rova/action-by-id-cache");

if (!_g[_intKey]) {
  _g[_intKey] = new Map<IntegrationType, RegisteredIntegrationPlugin>();
}
if (!_g[_cacheKey]) {
  _g[_cacheKey] = new Map<string, ActionWithFullId | undefined>();
}

// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- initialized above
const integrationRegistry = _g[_intKey] as Map<
  IntegrationType,
  RegisteredIntegrationPlugin
>;
/**
 * Compute full action ID from integration type and action slug
 */
export function computeActionId(
  integrationType: IntegrationType,
  actionSlug: string
): string {
  return `${integrationType}/${actionSlug}`;
}

/**
 * Parse a full action ID into integration type and action slug
 */
export function parseActionId(actionId: string | undefined | null): {
  integration: string;
  slug: string;
} | null {
  if (!actionId || typeof actionId !== "string") {
    return null;
  }
  const parts = actionId.split("/");
  if (parts.length !== 2) {
    return null;
  }
  return { integration: parts[0], slug: parts[1] };
}

/**
 * Read an action's output schema once, at registration.
 *
 * This is the one moment a plugin's metadata is handled before anything reads
 * it, which is where the schema bridge belongs: `requireOutputFieldsFromSchema`
 * gives an Effect schema its Standard Schema halves, and doing that twice for
 * the same schema is a decision about which crossing wins that no call site can
 * see.
 *
 * A schema that yields no usable list throws here rather than registering an
 * action whose autocomplete is empty or short. Registration runs on import, so
 * the failure lands in the build and the tests of whoever wrote the schema.
 */
function readPluginAction(
  integrationType: IntegrationType,
  action: PluginAction
): RegisteredPluginAction {
  const { output, ...rest } = action;

  if (!output) {
    return rest;
  }

  const actionId = computeActionId(integrationType, action.slug);

  if (rest.outputFields) {
    throw new Error(
      `Action "${actionId}" declares both an output schema and outputFields. The schema is the one the step is typed against, so the hand-written list can only disagree with it.`
    );
  }

  return {
    ...rest,
    outputFields: requireOutputFieldsFromSchema(actionId, output),
  };
}

/**
 * Register an integration plugin
 */
export function registerIntegration(plugin: IntegrationPlugin): void {
  integrationRegistry.set(plugin.type, {
    ...plugin,
    actions: plugin.actions.map((action) =>
      readPluginAction(plugin.type, action)
    ),
  });
  actionByIdCache.clear();
}

/**
 * Unregister an integration plugin by type
 */
export function unregisterIntegration(type: IntegrationType): void {
  integrationRegistry.delete(type);
  actionByIdCache.clear();
}

/**
 * Get an integration plugin
 */
export function getIntegration(
  type: string
): RegisteredIntegrationPlugin | undefined {
  if (!isIntegrationType(type)) {
    return undefined;
  }
  return integrationRegistry.get(type);
}

/**
 * Get all registered integrations
 */
export function getAllIntegrations(): RegisteredIntegrationPlugin[] {
  return Array.from(integrationRegistry.values());
}

/**
 * Get all integration types
 */
export function getIntegrationTypes(): IntegrationType[] {
  return Array.from(integrationRegistry.keys());
}

/**
 * Get all actions across all integrations with full IDs
 */
export function getAllActions(): ActionWithFullId[] {
  const actions: ActionWithFullId[] = [];

  for (const plugin of integrationRegistry.values()) {
    for (const action of plugin.actions) {
      actions.push({
        ...action,
        id: computeActionId(plugin.type, action.slug),
        integration: plugin.type,
      });
    }
  }

  for (const runtimeAction of getRuntimeActions()) {
    actions.push({
      slug: runtimeAction.id,
      label: runtimeAction.label,
      description: runtimeAction.description,
      category: runtimeAction.category,
      logoUrl: runtimeAction.logoUrl,
      configFields: runtimeAction.configFields ?? [],
      outputFields: runtimeAction.outputFields,
      id: runtimeAction.id,
      integration: runtimeAction.integration,
    });
  }

  return actions;
}

/**
 * Get actions by category
 */
export function getActionsByCategory(): Record<string, ActionWithFullId[]> {
  const categories: Record<string, ActionWithFullId[]> = {};

  for (const plugin of integrationRegistry.values()) {
    for (const action of plugin.actions) {
      if (!categories[action.category]) {
        categories[action.category] = [];
      }
      categories[action.category].push({
        ...action,
        id: computeActionId(plugin.type, action.slug),
        integration: plugin.type,
      });
    }
  }

  for (const runtimeAction of getRuntimeActions()) {
    if (!categories[runtimeAction.category]) {
      categories[runtimeAction.category] = [];
    }

    categories[runtimeAction.category].push({
      slug: runtimeAction.id,
      label: runtimeAction.label,
      description: runtimeAction.description,
      category: runtimeAction.category,
      logoUrl: runtimeAction.logoUrl,
      configFields: runtimeAction.configFields ?? [],
      outputFields: runtimeAction.outputFields,
      id: runtimeAction.id,
      integration: runtimeAction.integration,
    });
  }

  return categories;
}

// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- cross-bundle singleton
let cachedRuntimeVersion = -1;

// eslint-disable-next-line typescript/no-unsafe-type-assertion -- initialized above
const actionByIdCache = _g[_cacheKey] as Map<
  string,
  ActionWithFullId | undefined
>;

/**
 * Find an action by full ID (e.g., "resend/send-email")
 * Also supports action label-based IDs (e.g., "Send Email")
 */
export function findActionById(
  actionId: string | undefined | null
): ActionWithFullId | undefined {
  if (!actionId) {
    return undefined;
  }

  // The runtime-action half of this cache is invalidated by whoever writes to
  // that registry, which is a different module, so the version it last saw is
  // the only thing that can tell us the answer went stale.
  if (cachedRuntimeVersion !== getRuntimeActionRegistryVersion()) {
    cachedRuntimeVersion = getRuntimeActionRegistryVersion();
    actionByIdCache.clear();
  }

  const cached = actionByIdCache.get(actionId);
  if (cached !== undefined) {
    return cached;
  }

  // First try parsing as a namespaced ID
  const parsed = parseActionId(actionId);
  if (parsed) {
    const plugin = isIntegrationType(parsed.integration)
      ? integrationRegistry.get(parsed.integration)
      : undefined;
    if (plugin) {
      const action = plugin.actions.find((a) => a.slug === parsed.slug);
      if (action) {
        const result = {
          ...action,
          id: actionId,
          integration: plugin.type,
        };
        actionByIdCache.set(actionId, result);
        return result;
      }
    }
  }

  // Fall back to label-based lookup (exact label match)
  for (const runtimeAction of getRuntimeActions()) {
    if (runtimeAction.id === actionId || runtimeAction.label === actionId) {
      const result: ActionWithFullId = {
        slug: runtimeAction.id,
        label: runtimeAction.label,
        description: runtimeAction.description,
        category: runtimeAction.category,
        logoUrl: runtimeAction.logoUrl,
        configFields: runtimeAction.configFields ?? [],
        outputFields: runtimeAction.outputFields,
        id: runtimeAction.id,
        integration: runtimeAction.integration,
      };
      actionByIdCache.set(actionId, result);
      return result;
    }
  }

  // Fall back to label-based lookup (exact label match)
  for (const plugin of integrationRegistry.values()) {
    const action = plugin.actions.find((a) => a.label === actionId);
    if (action) {
      const result = {
        ...action,
        id: computeActionId(plugin.type, action.slug),
        integration: plugin.type,
      };
      actionByIdCache.set(actionId, result);
      return result;
    }
  }

  actionByIdCache.set(actionId, undefined);
  return undefined;
}

/**
 * Get integration labels map
 */
export function getIntegrationLabels(): Record<IntegrationType, string> {
  const labels: Record<string, string> = {};
  for (const plugin of integrationRegistry.values()) {
    labels[plugin.type] = plugin.label;
  }
  return labels;
}

/**
 * Get integration descriptions map
 */
export function getIntegrationDescriptions(): Record<IntegrationType, string> {
  const descriptions: Record<string, string> = {};
  for (const plugin of integrationRegistry.values()) {
    descriptions[plugin.type] = plugin.description;
  }
  return descriptions;
}

/**
 * Get sorted integration types for dropdowns
 */
export function getSortedIntegrationTypes(): IntegrationType[] {
  return Array.from(integrationRegistry.keys()).toSorted();
}

/**
 * Get credential mapping for a plugin (auto-generated from formFields)
 */
export function getCredentialMapping(
  plugin: IntegrationPlugin,
  config: Record<string, unknown>
): Record<string, string> {
  const creds: Record<string, string> = {};

  for (const field of plugin.formFields) {
    if (field.envVar && config[field.configKey]) {
      creds[field.envVar] = String(config[field.configKey]);
    }
  }

  return creds;
}

/**
 * Type guard to check if a field is a group
 */
export function isFieldGroup(
  field: ActionConfigField
): field is ActionConfigFieldGroup {
  return field.type === "group";
}

/**
 * Flatten config fields, extracting fields from groups
 * Useful for validation and AI prompt generation
 */
export function flattenConfigFields(
  fields: ActionConfigField[]
): ActionConfigFieldBase[] {
  const result: ActionConfigFieldBase[] = [];

  for (const field of fields) {
    if (isFieldGroup(field)) {
      result.push(...field.fields);
    } else {
      result.push(field);
    }
  }

  return result;
}
