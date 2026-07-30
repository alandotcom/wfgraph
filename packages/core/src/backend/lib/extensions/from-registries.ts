/**
 * The catalog's actions and integrations, read out of the registries.
 *
 * A plugin fills `plugins/registry.ts` on import and a host's `createAction`
 * fills `action-registry.ts`, so the surface those two hold is the surface to
 * serve. `defineIntegration` replaces both, and this file goes with them.
 *
 * Each function maps one registry's shape onto the catalog's and interprets
 * nothing, so a field the catalog carries and a registry does not is one visible
 * computed line.
 */

import {
  getAllActions,
  getAllIntegrations,
} from "@rova/shared/plugins/registry";
import type {
  ActionMetadata,
  CredentialFieldMetadata,
  IntegrationMetadata,
} from "@rova/shared/extensions/catalog";
import { hasIntegrationTest } from "#src/backend/services/integrations/integration-test-loaders";

/**
 * Every plugin action and every host-registered action, with its computed id.
 *
 * The built-in four are not here: `assembleExtensions` adds them, so a host
 * action that collides with one of them is caught by the same duplicate-id check
 * as any other collision.
 */
export function catalogActionsFromRegistries(): readonly ActionMetadata[] {
  return getAllActions().map((action) => ({
    id: action.id,
    label: action.label,
    description: action.description,
    category: action.category,
    ...(action.integration ? { integration: action.integration } : {}),
    ...(action.logoUrl ? { logoUrl: action.logoUrl } : {}),
    configFields: action.configFields,
    outputFields: action.outputFields,
  }));
}

/**
 * A plugin's credential form, which the registry calls `formFields`.
 *
 * The catalog says `credentialFields`, because that is what they are: the
 * integrations dialog is the only form they are ever drawn as.
 */
function toCredentialFields(
  formFields: ReturnType<typeof getAllIntegrations>[number]["formFields"]
): readonly CredentialFieldMetadata[] {
  return formFields.map((field) => ({
    label: field.label,
    type: field.type,
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.helpText ? { helpText: field.helpText } : {}),
    ...(field.helpLink ? { helpLink: field.helpLink } : {}),
    configKey: field.configKey,
    ...(field.envVar ? { envVar: field.envVar } : {}),
  }));
}

export function catalogIntegrationsFromRegistries(): readonly IntegrationMetadata[] {
  return getAllIntegrations().map((integration) => ({
    type: integration.type,
    label: integration.label,
    description: integration.description,
    credentialFields: toCredentialFields(integration.formFields),
    hasTest: hasIntegrationTest(integration.type),
  }));
}
