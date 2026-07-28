import { Schema } from "effect";
import { compact } from "es-toolkit/array";
import { getBasePath } from "#src/lib/base-path";
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

let hydrationPromise: Promise<void> | null = null;

const selectOptionSchema = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
});

/**
 * One declarative config field, matching `ActionConfigFieldBase` in the plugin
 * registry. The field types are a closed set because the config renderer
 * switches on them: a field the renderer cannot draw is not a usable field.
 *
 * The list fields are wrapped in `Schema.mutable` because the registry's own
 * types spell them as mutable arrays, and a decoded `readonly` array would not
 * satisfy them.
 */
const actionConfigFieldBaseSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.Literals([
    "template-input",
    "template-textarea",
    "text",
    "number",
    "select",
    "schema-builder",
    "key-value",
  ]),
  placeholder: Schema.optionalKey(Schema.String),
  defaultValue: Schema.optionalKey(Schema.String),
  example: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.mutable(Schema.Array(selectOptionSchema))),
  rows: Schema.optionalKey(Schema.Finite),
  min: Schema.optionalKey(Schema.Finite),
  required: Schema.optionalKey(Schema.Boolean),
  showWhen: Schema.optionalKey(
    Schema.Struct({
      field: Schema.String,
      equals: Schema.String,
    })
  ),
});

const actionConfigFieldGroupSchema = Schema.Struct({
  label: Schema.String,
  type: Schema.Literal("group"),
  fields: Schema.mutable(Schema.Array(actionConfigFieldBaseSchema)),
  defaultExpanded: Schema.optionalKey(Schema.Boolean),
});

// The annotation is the check: a schema that admits a field the registry's own
// contract does not have -- a type literal the config renderer cannot draw, say
// -- stops compiling here.
const actionConfigFieldSchema: Schema.Codec<ActionConfigField> = Schema.Union([
  actionConfigFieldGroupSchema,
  actionConfigFieldBaseSchema,
]);

const referenceFieldSchema: Schema.Codec<ReferenceField> = Schema.Struct({
  path: Schema.String,
  description: Schema.String,
  type: Schema.optionalKey(
    Schema.Literals([
      "string",
      "number",
      "boolean",
      "timestamp",
      "array",
      "object",
    ])
  ),
  format: Schema.optionalKey(Schema.Literal("timestamp")),
  nullable: Schema.optionalKey(Schema.Boolean),
  enumValues: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
});

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
    Schema.mutable(Schema.Array(actionConfigFieldSchema))
  ),
  outputFields: Schema.optionalKey(
    Schema.mutable(Schema.Array(referenceFieldSchema))
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
      Schema.mutable(Schema.Array(actionConfigFieldSchema))
    ),
    outputFields: Schema.optionalKey(
      Schema.mutable(Schema.Array(referenceFieldSchema))
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

export function hydrateRuntimeExtensionsFromApi(): Promise<void> {
  if (hydrationPromise) {
    return hydrationPromise;
  }

  hydrationPromise = (async () => {
    try {
      // Root-relative, so it has to carry the mount prefix itself: a URL
      // starting with "/" ignores <base href>, which only governs relative
      // references. Without this the editor silently comes up with no
      // host-defined actions when Rova is mounted under a sub-path.
      const response = await fetch(`${getBasePath()}/api/extensions`, {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        return;
      }

      const payload = readRuntimeExtensionsPayload(await response.json());

      clearRuntimeActions();
      runtimeTriggerRegistry.clear();

      if (!payload) {
        return;
      }

      for (const action of keepValidEntries(
        payload.actions,
        readRuntimeAction
      )) {
        registerRuntimeAction(action);
      }

      for (const trigger of keepValidEntries(
        payload.triggers,
        readRuntimeTrigger
      )) {
        runtimeTriggerRegistry.set(trigger.type, trigger);
      }
    } catch {
      // Runtime extensions are optional.
    }
  })();

  return hydrationPromise;
}
