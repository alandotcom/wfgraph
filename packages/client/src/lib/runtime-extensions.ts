import { Schema } from "effect";
import { compact } from "es-toolkit/array";
// The catalog's wire schema owns both field shapes, because both halves of this
// endpoint carry them and one decode contract is what keeps them agreeing.
import {
  actionConfigFieldWireSchema,
  referenceFieldWireSchema,
} from "@rova/shared/extensions/catalog-wire";
import type { ExtensionCatalog } from "@rova/shared/extensions/catalog";
import {
  type ActionConfigField,
  parseActionId,
  registerReadIntegration,
} from "@rova/shared/plugins/registry";
import { readAs } from "@rova/shared/types/schema";
import type { IntegrationType } from "@rova/shared/types/integration";
import {
  clearRuntimeActions,
  registerRuntimeAction,
  type RuntimeActionMetadata,
} from "@rova/shared/workflow/action-registry";
import type { ReferenceField } from "@rova/shared/workflow/node-references";

export type RuntimeTriggerDefinition = {
  type: string;
  label: string;
  executionType: "manual" | "webhook" | "event";
  description?: string;
  logoUrl?: string;
  configFields?: ActionConfigField[];
  outputFields?: ReferenceField[];
  /**
   * The trigger's closed Event Type vocabulary, when it has one. Drives the
   * Routing Policy rows and the Wait node's event options. Absent means the
   * vocabulary is open and the editor falls back to free-text rows.
   */
  /** The payload path runs correlate on, shown wherever correlation is explained. */
};

const runtimeTriggerRegistry = new Map<string, RuntimeTriggerDefinition>();

/**
 * An action registered at runtime by the host app, as `/api/extensions` sends it.
 *
 * The server side of this is `listRuntimeActions()`, which strips the action's
 * `execute` function before serializing: what arrives here is metadata the editor
 * uses to draw the action selector and its config form, and the run itself
 * happens on the server.
 */
const runtimeActionSchema: Schema.Codec<RuntimeActionMetadata> = Schema.Struct({
  // The selector keys on id and shows label, so both must carry a value.
  id: Schema.Trim.check(Schema.isNonEmpty()),
  label: Schema.Trim.check(Schema.isNonEmpty()),
  description: Schema.String,
  category: Schema.String,
  integration: Schema.optionalKey(Schema.String),
  logoUrl: Schema.optionalKey(Schema.String),
  configFields: Schema.optionalKey(
    Schema.mutable(Schema.Array(actionConfigFieldWireSchema))
  ),
  outputFields: Schema.optionalKey(
    Schema.mutable(Schema.Array(referenceFieldWireSchema))
  ),
});

const runtimeTriggerSchema: Schema.Codec<RuntimeTriggerDefinition> =
  Schema.Struct({
    type: Schema.Trim.check(Schema.isNonEmpty()),
    label: Schema.Trim.check(Schema.isNonEmpty()),
    executionType: Schema.Literals(["manual", "webhook", "event"]),
    description: Schema.optionalKey(Schema.String),
    logoUrl: Schema.optionalKey(Schema.String),
    configFields: Schema.optionalKey(
      Schema.mutable(Schema.Array(actionConfigFieldWireSchema))
    ),
    outputFields: Schema.optionalKey(
      Schema.mutable(Schema.Array(referenceFieldWireSchema))
    ),
  });

const readRuntimeAction = readAs(runtimeActionSchema);
const readRuntimeTrigger = readAs(runtimeTriggerSchema);

/**
 * Validates entries one at a time, keeping the ones that pass. A definition the
 * editor cannot use costs only itself: the rest of the host app's actions and
 * triggers still reach the selector.
 */
function keepValidEntries<T>(
  entries: readonly unknown[] | undefined,
  read: (entry: unknown) => T | undefined
): T[] {
  return compact(entries?.map(read) ?? []);
}

/**
 * The triggers the server registered, which the editor no longer offers: an entry
 * node has no type to pick and what starts a run is the Lifecycle Rules. The
 * registry is still filled from the envelope, and reading it back is how the
 * hydration test proves that; B4 deletes the surface it decodes.
 */
export function getRuntimeTriggers(): RuntimeTriggerDefinition[] {
  return Array.from(runtimeTriggerRegistry.values());
}

/**
 * Fill the plugin registry from the catalog.
 *
 * The catalog is the browser's one producer of integration metadata: nothing here
 * imports a plugin, so a ported integration's definition and a registered one's
 * entry both arrive the same way, over the wire. Every reader in the editor still
 * asks the registry, so this is where the two meet, and B4 points those readers at
 * the catalog and deletes this.
 *
 * Two fields of the registry's own shape have no wire form and are left unset:
 * an action's `outputConfig` and an integration's `dependencies`, neither of which
 * anything declares today.
 */
export function hydrateIntegrationsFromCatalog(
  catalog: ExtensionCatalog
): void {
  for (const integration of catalog.integrations) {
    registerReadIntegration({
      // The registry is keyed by the closed `IntegrationType` union and the wire
      // carries a string. Every producer of a catalog entry is typed against that
      // same union -- `defineIntegration` and the plugin registry both -- so a
      // type outside it cannot reach here, and narrowing by dropping the entry
      // instead would hide an integration rather than fail. The cast and the union
      // go together in B4.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- see above
      type: integration.type as IntegrationType,
      label: integration.label,
      description: integration.description,
      formFields: integration.credentialFields.map((field) => ({
        ...field,
        // The registry's shape carries a form id; the catalog's does not, because
        // a field has one name and it is the config key.
        id: field.configKey,
      })),
      actions: catalog.actions
        .filter((action) => action.integration === integration.type)
        .map((action) => ({
          slug: parseActionId(action.id)?.slug ?? action.id,
          label: action.label,
          description: action.description,
          category: action.category,
          configFields: [...action.configFields],
          outputFields: [...action.outputFields],
        })),
    });
  }
}

/**
 * Fill both registries from the two legacy members `/api/extensions` answered.
 *
 * The fetch and the envelope decode belong to `lib/extensions.ts`, which hands
 * the decoded envelope here: one endpoint answers both halves of the surface, so
 * one request reads it, and the envelope's own schema is what establishes that
 * these two members are lists. This half is a decoder and nothing else, and it
 * goes when the registries do.
 */
export function hydrateRuntimeExtensions(envelope: {
  readonly actions?: readonly unknown[];
  readonly triggers?: readonly unknown[];
}): void {
  clearRuntimeActions();
  runtimeTriggerRegistry.clear();

  for (const action of keepValidEntries(envelope.actions, readRuntimeAction)) {
    registerRuntimeAction(action);
  }

  for (const trigger of keepValidEntries(
    envelope.triggers,
    readRuntimeTrigger
  )) {
    runtimeTriggerRegistry.set(trigger.type, trigger);
  }
}
