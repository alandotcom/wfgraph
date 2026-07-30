/**
 * The webhook trigger's schema, as the config panel deals with it.
 *
 * A webhook trigger stores two schemas as JSON strings in node config:
 * `webhookSchema` (the request contract) and `webhookOutputSchema` (what the
 * trigger hands downstream). This module owns reading those strings back into
 * a schema tree, inferring a tree from a sample payload, and flattening a tree
 * into the dotted paths the routing selectors offer.
 *
 * Path grammar note: the paths produced here address array elements with a
 * numeric segment (`items.0.sku`), because they are stored in
 * `webhookEventPath` / `webhookCorrelationPath` and resolved at run time by
 * `getValueByPath` in `@rova/shared/utils/object-path`, which splits on dots only.
 * The template grammar in `@rova/shared/workflow/node-references` flattens the same
 * kind of tree into `items[0].sku` for its own walker. Two resolvers, two
 * spellings; a path from here must never be fed to that walker or vice versa.
 */

import {
  type JsonObject,
  readJsonObject,
  type JsonValue,
} from "@rova/shared/types/json";
import {
  parseWorkflowSchemaFieldsOrJsonSchema,
  type WorkflowSchemaField,
} from "@rova/shared/workflow/schema-codec";
import type { NodeConfigPatch } from "./node-config-patch";

/** Which editor the user has open for a schema: the field builder or raw JSON. */
export type SchemaEditorMode = "builder" | "json";

const ISO8601_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Read a config value that is expected to be a string, with a stand-in value. */
export function readConfigString(
  config: Record<string, unknown>,
  key: string,
  fallback = ""
): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

/**
 * Parse one config key back into a schema tree.
 *
 * Accepts either storage shape: the field array the builder writes, or a JSON
 * Schema document a user pasted into the JSON tab. An unreadable value yields
 * an empty schema, so a broken string never breaks the panel.
 */
export function readSchemaFromConfigKey(
  config: Record<string, unknown>,
  key: string
): WorkflowSchemaField[] {
  const raw = config[key];
  if (typeof raw !== "string" || !raw) {
    return [];
  }

  try {
    return parseWorkflowSchemaFieldsOrJsonSchema(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

/** The request contract a webhook trigger accepts. */
export function readWebhookRequestSchema(
  config: Record<string, unknown>
): WorkflowSchemaField[] {
  return readSchemaFromConfigKey(config, "webhookSchema");
}

/** The contract the trigger publishes downstream, which autocomplete reads. */
export function readWebhookOutputSchema(
  config: Record<string, unknown>
): WorkflowSchemaField[] {
  return readSchemaFromConfigKey(config, "webhookOutputSchema");
}

export function isSchemaEditorMode(value: string): value is SchemaEditorMode {
  return value === "builder" || value === "json";
}

/**
 * Whether a string is a full timestamp with an offset, such as
 * `2026-02-11T18:00:00Z`. Used to tell a date apart from an ordinary string
 * when inferring a schema, so condition rows offer time operators for it.
 */
export function isIso8601Timestamp(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (!ISO8601_TIMESTAMP_REGEX.test(normalized)) {
    return false;
  }

  return !Number.isNaN(Date.parse(normalized));
}

/**
 * `undefined` is admitted because an empty array in the sample payload offers no
 * element to describe, and such an array is still reported as an array of
 * strings.
 */
export function inferPrimitiveType(
  value: JsonValue | undefined
): "string" | "number" | "boolean" | "timestamp" {
  if (typeof value === "number") {
    return "number";
  }

  if (typeof value === "boolean") {
    return "boolean";
  }

  if (typeof value === "string" && isIso8601Timestamp(value)) {
    return "timestamp";
  }

  return "string";
}

/**
 * Describe one payload entry as a schema field. An array is described by its
 * first element, which is the only evidence a single sample payload offers.
 */
export function inferSchemaField(
  name: string,
  value: JsonValue | undefined
): WorkflowSchemaField {
  if (Array.isArray(value)) {
    const first = value.at(0);

    if (typeof first === "object" && first !== null && !Array.isArray(first)) {
      return {
        name,
        type: "array",
        itemType: "object",
        fields: inferSchemaFromPayload(first),
      };
    }

    return {
      name,
      type: "array",
      itemType: inferPrimitiveType(first),
    };
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return {
      name,
      type: "object",
      fields: inferSchemaFromPayload(value),
    };
  }

  return {
    name,
    type: inferPrimitiveType(value),
  };
}

/** Turn a sample webhook payload into the schema it implies. */
export function inferSchemaFromPayload(
  payload: JsonObject
): WorkflowSchemaField[] {
  return Object.entries(payload).map(([key, value]) =>
    inferSchemaField(key, value)
  );
}

/** A schema serialized for storage; `null` means the user cleared the editor. */
function storeSchema(schema: WorkflowSchemaField[] | null): string {
  return schema === null ? "" : JSON.stringify(schema);
}

/**
 * The rule that keeps a webhook trigger's two schemas in step.
 *
 * A webhook's request contract is also what the trigger hands downstream, so
 * every edit to the request schema republishes it as the output contract. Both
 * keys move together, including when the schema is cleared: template
 * autocomplete reads `webhookOutputSchema`, and leaving a stale copy there is
 * how it ends up offering fields from a schema the user just deleted.
 *
 * The rule runs one way only. A user can narrow the published contract on its
 * own through the output schema editor, and `webhookOutputSchemaPatch` is the
 * write that does it.
 */
export function webhookRequestSchemaPatch(
  schema: WorkflowSchemaField[] | null
): NodeConfigPatch {
  const stored = storeSchema(schema);
  return { webhookSchema: stored, webhookOutputSchema: stored };
}

/** Publish a different contract downstream than the request schema describes. */
export function webhookOutputSchemaPatch(
  schema: WorkflowSchemaField[] | null
): NodeConfigPatch {
  return { webhookOutputSchema: storeSchema(schema) };
}

/**
 * What the text in a schema JSON editor currently says: a schema, an emptied
 * editor (`schema: null`, which the pairing rule reads as a clear), or a
 * message explaining why nothing can be stored yet.
 */
export type SchemaJsonEdit =
  | { ok: true; schema: WorkflowSchemaField[] | null }
  | { ok: false; error: string };

export function parseSchemaJsonEdit(nextValue: string): SchemaJsonEdit {
  if (!nextValue.trim()) {
    return { ok: true, schema: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(nextValue);
  } catch {
    return { ok: false, error: "Schema is not valid JSON." };
  }

  const schema = parseWorkflowSchemaFieldsOrJsonSchema(parsed);
  if (!schema) {
    return {
      ok: false,
      error:
        "Schema must be either a field array or a JSON Schema object with top-level properties.",
    };
  }

  return { ok: true, schema };
}

/**
 * Read a sample payload as a statement of the request contract.
 *
 * Whatever a user pastes into the sample payload editor defines the schema, so
 * the two stay consistent without a second round of typing. Text that is not a
 * JSON object says nothing about the contract and leaves both schemas alone.
 */
export function webhookSchemaPatchFromSamplePayload(
  rawPayload: string
): NodeConfigPatch {
  if (!rawPayload.trim()) {
    return {};
  }

  try {
    const payload = readJsonObject(JSON.parse(rawPayload));
    if (!payload) {
      return {};
    }

    return webhookRequestSchemaPatch(inferSchemaFromPayload(payload));
  } catch {
    return {};
  }
}
