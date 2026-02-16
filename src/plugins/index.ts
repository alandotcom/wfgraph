/**
 * Plugins Index
 *
 * Manually maintained static imports for enabled plugins.
 */

import "./acuity";
import "./clerk";
import "./linear";
import "./resend";
import "./slack";
import "./twilio";

export type {
  ActionConfigField,
  ActionConfigFieldBase,
  ActionConfigFieldGroup,
  ActionWithFullId,
  IntegrationPlugin,
  PluginAction,
  RuntimeActionDefinition,
} from "./registry";

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
} from "./registry";
