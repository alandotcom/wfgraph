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
  PluginAction,
} from "@rova/shared/plugins/registry";
export type {
  RegisteredRuntimeAction,
  RuntimeActionMetadata,
} from "@rova/shared/workflow/action-registry";

// Export the registry utilities
export {
  clearRuntimeActions,
  getRuntimeActions,
  registerRuntimeAction,
} from "@rova/shared/workflow/action-registry";
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
} from "@rova/shared/plugins/registry";

// The flat field shape an action or trigger declares in `outputFields`.
export type { ReferenceField } from "@rova/shared/workflow/node-references";
