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
 * `getValueByPath` in `@/shared/utils/object-path`, which splits on dots only.
 * The template grammar in `@/shared/workflow/node-references` flattens the same
 * kind of tree into `items[0].sku` for its own walker. Two resolvers, two
 * spellings; a path from here must never be fed to that walker or vice versa.
 */

import {
  parseWorkflowSchemaFieldsOrJsonSchema,
  type WorkflowSchemaField,
} from "@/shared/workflow/schema-codec";

/** Which editor the user has open for a schema: the field builder or raw JSON. */
export type SchemaEditorMode = "builder" | "json";

/** One dotted path a routing selector can offer, with the type found there. */
export type SchemaPathOption = {
  path: string;
  type: WorkflowSchemaField["type"] | WorkflowSchemaField["itemType"];
};

const ISO8601_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function inferPrimitiveType(
  value: unknown
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
  value: unknown
): WorkflowSchemaField {
  if (Array.isArray(value)) {
    const first = value.at(0);

    if (isRecord(first)) {
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

  if (isRecord(value)) {
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
  payload: Record<string, unknown>
): WorkflowSchemaField[] {
  return Object.entries(payload).map(([key, value]) =>
    inferSchemaField(key, value)
  );
}

/**
 * Flatten a schema tree into every path a routing selector can offer.
 *
 * Containers are listed alongside their children so a user can point routing at
 * a whole object. An array of objects contributes `name.0.child`; an array of
 * primitives contributes only itself, since its elements have no names.
 */
export function flattenSchemaPathOptions(
  schema: WorkflowSchemaField[],
  prefix = ""
): SchemaPathOption[] {
  const paths: SchemaPathOption[] = [];

  for (const field of schema) {
    const fieldName = field.name.trim();

    if (!fieldName) {
      continue;
    }

    const currentPath = prefix ? `${prefix}.${fieldName}` : fieldName;
    paths.push({ path: currentPath, type: field.type });

    if (field.type === "object" && field.fields?.length) {
      paths.push(...flattenSchemaPathOptions(field.fields, currentPath));
    }

    if (
      field.type === "array" &&
      field.itemType === "object" &&
      field.fields?.length
    ) {
      paths.push(...flattenSchemaPathOptions(field.fields, `${currentPath}.0`));
    }
  }

  return paths;
}
