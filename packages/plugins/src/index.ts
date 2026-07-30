/**
 * The plugins that still register themselves on import.
 *
 * Importing this module is what turns them on, and the browser imports it too:
 * their metadata is what the editor draws them with. A plugin B4 has ported is
 * not here, because a definition reaches the server as a value and the browser
 * reads it off the catalog instead. This module goes when the last one moves.
 */

import acuityPlugin from "./acuity";
import clerkPlugin from "./clerk";
import linearPlugin from "./linear";
import resendPlugin from "./resend";
import slackPlugin from "./slack";

export const REGISTERED_PLUGINS = [
  acuityPlugin,
  clerkPlugin,
  linearPlugin,
  resendPlugin,
  slackPlugin,
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
  getActionsByCategory,
  getAllActions,
  getAllIntegrations,
  getIntegration,
  getIntegrationLabels,
  getSortedIntegrationTypes,
  isFieldGroup,
  parseActionId,
  registerIntegration,
} from "@rova/shared/plugins/registry";

// The flat field shape an action or trigger declares in `outputFields`.
export type { ReferenceField } from "@rova/shared/workflow/node-references";
