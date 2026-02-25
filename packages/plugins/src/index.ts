/**
 * Plugins Index
 *
 * Manually maintained static imports for enabled plugins.
 * Importing this module triggers plugin registration (side effects).
 */

import acuityPlugin from "./acuity";
import clerkPlugin from "./clerk";
import linearPlugin from "./linear";
import resendPlugin from "./resend";
import slackPlugin from "./slack";
import twilioPlugin from "./twilio";

export const REGISTERED_PLUGINS = [
  acuityPlugin,
  clerkPlugin,
  linearPlugin,
  resendPlugin,
  slackPlugin,
  twilioPlugin,
] as const;

export type {
  ActionConfigField,
  ActionConfigFieldBase,
  ActionConfigFieldGroup,
  ActionWithFullId,
  IntegrationPlugin,
  OutputField,
  PluginAction,
  RuntimeActionDefinition,
} from "@/shared/plugins/registry";

// Export the registry utilities
export {
  clearRuntimeActions,
  computeActionId,
  findActionById,
  flattenConfigFields,
  generateAIActionPrompts,
  getActionsByCategory,
  getAllActions,
  getAllDependencies,
  getAllEnvVars,
  getAllIntegrations,
  getCredentialMapping,
  getDependenciesForActions,
  getIntegration,
  getIntegrationLabels,
  getIntegrationTypes,
  getPluginEnvVars,
  getRuntimeActions,
  getSortedIntegrationTypes,
  isFieldGroup,
  parseActionId,
  registerIntegration,
  registerRuntimeAction,
} from "@/shared/plugins/registry";
