import { type IntegrationType, isIntegrationType } from "@/types/integration";
import type { ReferenceField } from "@/workflow/node-references";

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
 * Result Component Props
 * Props passed to custom result components
 */
export type ResultComponentProps = {
  output: unknown;
  input?: unknown;
};

/**
 * Output Display Config
 * Specifies how to render step output in the workflow runs panel
 */
export type OutputDisplayConfig =
  | {
      // Built-in display types
      type: "image" | "video" | "url";
      // Field name in the step output that contains the displayable value
      field: string;
    }
  | {
      // Custom component display
      type: "component";
      // React component to render the output
      component: React.ComponentType<ResultComponentProps>;
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

  // Step configuration
  stepFunction: string; // Name of the exported function in the step file
  stepImportPath: string; // Path to import from, relative to plugins/[plugin-name]/steps/

  // Config fields for the action (declarative definition)
  configFields: ActionConfigField[];

  // Output fields for template autocomplete (what this action returns)
  outputFields?: ReferenceField[];

  // Output display configuration (how to render output in workflow runs panel)
  outputConfig?: OutputDisplayConfig;
};

/**
 * Integration Plugin Definition
 * All information needed to register a new integration in one place
 */
export type IntegrationPlugin = {
  // Basic info
  type: IntegrationType;
  label: string;
  description: string;

  // Icon component (should be exported from plugins/[name]/icon.tsx)
  icon: React.ComponentType<{ className?: string }>;

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

/**
 * Action with full ID
 * Includes the computed full action ID (integration/slug)
 */
export type ActionWithFullId = PluginAction & {
  id: string; // Full action ID: {integration}/{slug}
  integration?: string;
  logoUrl?: string;
};

export type RuntimeActionDefinition = {
  id: string;
  label: string;
  description: string;
  category: string;
  logoUrl?: string;
  configFields?: ActionConfigField[];
  outputFields?: ReferenceField[];
  integration?: string;
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
const _rtKey = Symbol.for("@rova/runtime-action-registry");
const _cacheKey = Symbol.for("@rova/action-by-id-cache");

if (!_g[_intKey]) {
  _g[_intKey] = new Map<IntegrationType, IntegrationPlugin>();
}
if (!_g[_rtKey]) {
  _g[_rtKey] = new Map<string, RuntimeActionDefinition>();
}
if (!_g[_cacheKey]) {
  _g[_cacheKey] = new Map<string, ActionWithFullId | undefined>();
}

// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- initialized above
const integrationRegistry = _g[_intKey] as Map<
  IntegrationType,
  IntegrationPlugin
>;
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- initialized above
const runtimeActionRegistry = _g[_rtKey] as Map<
  string,
  RuntimeActionDefinition
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
 * Register an integration plugin
 */
export function registerIntegration(plugin: IntegrationPlugin): void {
  integrationRegistry.set(plugin.type, plugin);
  actionByIdCache.clear();
}

/**
 * Unregister an integration plugin by type
 */
export function unregisterIntegration(type: IntegrationType): void {
  integrationRegistry.delete(type);
  actionByIdCache.clear();
}

export function registerRuntimeAction(action: RuntimeActionDefinition): void {
  runtimeActionRegistry.set(action.id, action);
  actionByIdCache.clear();
}

export function clearRuntimeActions(): void {
  runtimeActionRegistry.clear();
  actionByIdCache.clear();
}

export function getRuntimeActions(): RuntimeActionDefinition[] {
  return Array.from(runtimeActionRegistry.values());
}

/**
 * Get an integration plugin
 */
export function getIntegration(type: string): IntegrationPlugin | undefined {
  if (!isIntegrationType(type)) {
    return;
  }
  return integrationRegistry.get(type);
}

/**
 * Get all registered integrations
 */
export function getAllIntegrations(): IntegrationPlugin[] {
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

  for (const runtimeAction of runtimeActionRegistry.values()) {
    actions.push({
      slug: runtimeAction.id,
      label: runtimeAction.label,
      description: runtimeAction.description,
      category: runtimeAction.category,
      logoUrl: runtimeAction.logoUrl,
      stepFunction: "runtime",
      stepImportPath: "runtime",
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

  for (const runtimeAction of runtimeActionRegistry.values()) {
    if (!categories[runtimeAction.category]) {
      categories[runtimeAction.category] = [];
    }

    categories[runtimeAction.category].push({
      slug: runtimeAction.id,
      label: runtimeAction.label,
      description: runtimeAction.description,
      category: runtimeAction.category,
      logoUrl: runtimeAction.logoUrl,
      stepFunction: "runtime",
      stepImportPath: "runtime",
      configFields: runtimeAction.configFields ?? [],
      outputFields: runtimeAction.outputFields,
      id: runtimeAction.id,
      integration: runtimeAction.integration,
    });
  }

  return categories;
}

// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- cross-bundle singleton
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
    return;
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
  for (const runtimeAction of runtimeActionRegistry.values()) {
    if (runtimeAction.id === actionId || runtimeAction.label === actionId) {
      const result: ActionWithFullId = {
        slug: runtimeAction.id,
        label: runtimeAction.label,
        description: runtimeAction.description,
        category: runtimeAction.category,
        logoUrl: runtimeAction.logoUrl,
        stepFunction: "runtime",
        stepImportPath: "runtime",
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
  return;
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
 * Get all NPM dependencies across all integrations
 */
export function getAllDependencies(): Record<string, string> {
  const deps: Record<string, string> = {};

  for (const plugin of integrationRegistry.values()) {
    if (plugin.dependencies) {
      Object.assign(deps, plugin.dependencies);
    }
  }

  return deps;
}

/**
 * Get NPM dependencies for specific action IDs
 */
export function getDependenciesForActions(
  actionIds: string[]
): Record<string, string> {
  const deps: Record<string, string> = {};
  const integrations = new Set<IntegrationType>();

  // Find which integrations are used
  for (const actionId of actionIds) {
    const action = findActionById(actionId);
    if (
      action?.integration &&
      isIntegrationType(action.integration) &&
      integrationRegistry.has(action.integration)
    ) {
      integrations.add(action.integration);
    }
  }

  // Get dependencies for those integrations
  for (const integrationType of integrations) {
    const plugin = integrationRegistry.get(integrationType);
    if (plugin?.dependencies) {
      Object.assign(deps, plugin.dependencies);
    }
  }

  return deps;
}

/**
 * Get environment variables for a single plugin (from formFields)
 */
export function getPluginEnvVars(
  plugin: IntegrationPlugin
): Array<{ name: string; description: string }> {
  const envVars: Array<{ name: string; description: string }> = [];

  // Get env vars from form fields
  for (const field of plugin.formFields) {
    if (field.envVar) {
      envVars.push({
        name: field.envVar,
        description: field.helpText || field.label,
      });
    }
  }

  return envVars;
}

/**
 * Get all environment variables across all integrations
 */
export function getAllEnvVars(): Array<{ name: string; description: string }> {
  const envVars: Array<{ name: string; description: string }> = [];

  for (const plugin of integrationRegistry.values()) {
    envVars.push(...getPluginEnvVars(plugin));
  }

  return envVars;
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

function getFieldExampleValue(
  field: ReturnType<typeof flattenConfigFields>[number]
): string | number {
  if (field.example !== undefined) {
    return field.example;
  }
  if (field.defaultValue !== undefined) {
    return field.defaultValue;
  }
  if (field.type === "number") {
    return 10;
  }
  if (field.type === "select" && field.options?.[0]) {
    return field.options[0].value;
  }
  return `Your ${field.label.toLowerCase()}`;
}

function buildActionExampleConfig(
  fullId: string,
  configFields: Parameters<typeof flattenConfigFields>[0]
): Record<string, string | number> {
  const config: Record<string, string | number> = { actionType: fullId };
  for (const field of flattenConfigFields(configFields)) {
    if (!field.showWhen) {
      config[field.key] = getFieldExampleValue(field);
    }
  }
  return config;
}

/**
 * Generate AI prompt section for all available actions
 * This dynamically builds the action types documentation for the AI
 */
export function generateAIActionPrompts(): string {
  const lines: string[] = [];

  for (const plugin of integrationRegistry.values()) {
    for (const action of plugin.actions) {
      const fullId = computeActionId(plugin.type, action.slug);
      const exampleConfig = buildActionExampleConfig(
        fullId,
        action.configFields
      );
      lines.push(
        `- ${action.label} (${fullId}): ${JSON.stringify(exampleConfig)}`
      );
    }
  }

  return lines.join("\n");
}
