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
} from "./registry";

// Export the registry utilities
export {
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
  getSortedIntegrationTypes,
  isFieldGroup,
  parseActionId,
  registerIntegration,
} from "./registry";
