import { z } from "zod";
import {
  type ActionConfigField,
  clearRuntimeActions,
  type RuntimeActionDefinition,
  registerRuntimeAction,
} from "@/plugins/registry";
import type { ReferenceField } from "@/shared/workflow/node-references";

export type RuntimeTriggerDefinition = {
  type: string;
  label: string;
  executionType: "manual" | "webhook" | "event";
  description?: string;
  logoUrl?: string;
  configFields?: ActionConfigField[];
  outputFields?: ReferenceField[];
};

const runtimeTriggerRegistry = new Map<string, RuntimeTriggerDefinition>();

let hydrationPromise: Promise<void> | null = null;

const selectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});

/**
 * One declarative config field, matching `ActionConfigFieldBase` in the plugin
 * registry. The field types are a closed set because the config renderer
 * switches on them: a field the renderer cannot draw is not a usable field.
 */
const actionConfigFieldBaseSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum([
    "template-input",
    "template-textarea",
    "text",
    "number",
    "select",
    "schema-builder",
    "key-value",
  ]),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  example: z.string().optional(),
  options: z.array(selectOptionSchema).optional(),
  rows: z.number().optional(),
  min: z.number().optional(),
  required: z.boolean().optional(),
  showWhen: z
    .object({
      field: z.string(),
      equals: z.string(),
    })
    .optional(),
});

const actionConfigFieldGroupSchema = z.object({
  label: z.string(),
  type: z.literal("group"),
  fields: z.array(actionConfigFieldBaseSchema),
  defaultExpanded: z.boolean().optional(),
});

// The annotation is the check: if the registry's field contract gains a case,
// this stops compiling until the schema above learns about it.
const actionConfigFieldSchema: z.ZodType<ActionConfigField> = z.union([
  actionConfigFieldGroupSchema,
  actionConfigFieldBaseSchema,
]);

const referenceFieldSchema: z.ZodType<ReferenceField> = z.object({
  path: z.string(),
  description: z.string(),
  type: z
    .enum(["string", "number", "boolean", "timestamp", "array", "object"])
    .optional(),
  format: z.literal("timestamp").optional(),
  nullable: z.boolean().optional(),
  enumValues: z.array(z.string()).optional(),
});

/**
 * An action registered at runtime by the host app, as `/api/extensions` sends it.
 *
 * The server side of this is `listRuntimeActions()`, which strips the action's
 * `execute` function before serializing: what arrives here is metadata the editor
 * uses to draw the action selector and its config form, and the run itself
 * happens on the server.
 */
const runtimeActionSchema: z.ZodType<RuntimeActionDefinition> = z.object({
  // The selector keys on id and shows label, so both must carry a value.
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string(),
  category: z.string(),
  integration: z.string().optional(),
  logoUrl: z.string().optional(),
  configFields: z.array(actionConfigFieldSchema).optional(),
  outputFields: z.array(referenceFieldSchema).optional(),
});

const runtimeTriggerSchema: z.ZodType<RuntimeTriggerDefinition> = z.object({
  type: z.string().trim().min(1),
  label: z.string().trim().min(1),
  executionType: z.enum(["manual", "webhook", "event"]),
  description: z.string().optional(),
  logoUrl: z.string().optional(),
  configFields: z.array(actionConfigFieldSchema).optional(),
  outputFields: z.array(referenceFieldSchema).optional(),
});

/**
 * An array whose entries are validated one at a time, keeping the ones that pass.
 * A definition the editor cannot use costs only itself: the rest of the host
 * app's actions and triggers still reach the selector.
 */
function droppingInvalidEntries<T>(entrySchema: z.ZodType<T>) {
  return z
    .array(entrySchema.nullable().catch(null))
    .transform((entries) => entries.filter((entry) => entry !== null));
}

const runtimeExtensionsPayloadSchema = z.object({
  actions: droppingInvalidEntries(runtimeActionSchema).optional(),
  triggers: droppingInvalidEntries(runtimeTriggerSchema).optional(),
});

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
      const response = await fetch("/api/extensions", {
        method: "GET",
        headers: {
          accept: "application/json",
        },
      });

      if (!response.ok) {
        return;
      }

      const payload = runtimeExtensionsPayloadSchema.safeParse(
        await response.json()
      );

      clearRuntimeActions();
      runtimeTriggerRegistry.clear();

      if (!payload.success) {
        return;
      }

      for (const action of payload.data.actions ?? []) {
        registerRuntimeAction(action);
      }

      for (const trigger of payload.data.triggers ?? []) {
        runtimeTriggerRegistry.set(trigger.type, trigger);
      }
    } catch {
      // Runtime extensions are optional.
    }
  })();

  return hydrationPromise;
}
