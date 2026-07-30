import { Schema } from "effect";
import { compact } from "es-toolkit/array";
// The catalog's wire schema owns both field shapes, because both halves of this
// endpoint carry them and one decode contract is what keeps them agreeing.
import {
  actionConfigFieldWireSchema,
  referenceFieldWireSchema,
} from "@rova/shared/extensions/catalog-wire";
import type { ActionConfigField } from "@rova/shared/plugins/registry";
import { readAs } from "@rova/shared/types/schema";
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
