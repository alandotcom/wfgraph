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
  eventTypes?: string[];
  /** The payload path runs correlate on, shown wherever correlation is explained. */
  correlationPath?: string;
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
    eventTypes: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
    correlationPath: Schema.optionalKey(Schema.String),
  });

const readRuntimeAction = readAs(runtimeActionSchema);
const readRuntimeTrigger = readAs(runtimeTriggerSchema);

/**
 * The envelope only has to be an object holding two lists. Each entry stays
 * `unknown` here so that one unusable definition does not sink the list it sits
 * in; `keepValidEntries` reads them one at a time below.
 */
const readRuntimeExtensionsPayload = readAs(
  Schema.Struct({
    actions: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    triggers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  })
);

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

export function getRuntimeTriggers(): RuntimeTriggerDefinition[] {
  return Array.from(runtimeTriggerRegistry.values());
}

export function findRuntimeTrigger(
  type: string
): RuntimeTriggerDefinition | undefined {
  return runtimeTriggerRegistry.get(type);
}

/**
 * Fill both registries from what `/api/extensions` answered.
 *
 * The fetch belongs to `lib/extensions.ts`, which hands the whole payload here:
 * one endpoint answers both halves of the surface, so one request reads it. This
 * half is a decoder and nothing else, and it goes when the registries do.
 */
export function hydrateRuntimeExtensions(payload: unknown): void {
  const lists = readRuntimeExtensionsPayload(payload);

  clearRuntimeActions();
  runtimeTriggerRegistry.clear();

  if (!lists) {
    return;
  }

  for (const action of keepValidEntries(lists.actions, readRuntimeAction)) {
    registerRuntimeAction(action);
  }

  for (const trigger of keepValidEntries(lists.triggers, readRuntimeTrigger)) {
    runtimeTriggerRegistry.set(trigger.type, trigger);
  }
}
