import type {
  ConditionFieldDefinition,
  ConditionFieldType,
} from "@/shared/workflow/conditions";

export type WebhookSchemaField = {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  itemType?: "string" | "number" | "boolean" | "object";
  fields?: WebhookSchemaField[];
  format?: "timestamp";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWebhookSchemaField(
  value: unknown
): value is WebhookSchemaField {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.name !== "string") {
    return false;
  }

  if (
    value.type !== "string" &&
    value.type !== "number" &&
    value.type !== "boolean" &&
    value.type !== "array" &&
    value.type !== "object"
  ) {
    return false;
  }

  if (
    value.itemType !== undefined &&
    value.itemType !== "string" &&
    value.itemType !== "number" &&
    value.itemType !== "boolean" &&
    value.itemType !== "object"
  ) {
    return false;
  }

  if (value.format !== undefined && value.format !== "timestamp") {
    return false;
  }

  if (value.fields !== undefined) {
    if (!Array.isArray(value.fields)) {
      return false;
    }
    if (!value.fields.every((field) => isWebhookSchemaField(field))) {
      return false;
    }
  }

  return true;
}

function resolvePrimitiveType(
  type: "string" | "number" | "boolean",
  format: WebhookSchemaField["format"]
): ConditionFieldType {
  if (type === "string" && format === "timestamp") {
    return "timestamp";
  }

  return type;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Flattening handles object/array recursion and primitive timestamp detection in one pass.
function flattenSchemaFields(input: {
  schema: WebhookSchemaField[];
  prefix?: string;
  output: ConditionFieldDefinition[];
}) {
  const { schema, prefix = "", output } = input;

  for (const field of schema) {
    if (!field.name || typeof field.name !== "string") {
      continue;
    }

    const path = prefix ? `${prefix}.${field.name}` : field.name;

    if (
      field.type === "string" ||
      field.type === "number" ||
      field.type === "boolean"
    ) {
      output.push({
        path,
        label: path,
        type: resolvePrimitiveType(field.type, field.format),
      });
      continue;
    }

    if (field.type === "object") {
      if (Array.isArray(field.fields) && field.fields.length > 0) {
        flattenSchemaFields({
          schema: field.fields,
          prefix: path,
          output,
        });
      }
      continue;
    }

    if (field.type === "array") {
      if (
        field.itemType === "string" ||
        field.itemType === "number" ||
        field.itemType === "boolean"
      ) {
        output.push({
          path: `${path}[0]`,
          label: `${path}[0]`,
          type: resolvePrimitiveType(field.itemType, field.format),
        });
      }

      if (
        field.itemType === "object" &&
        Array.isArray(field.fields) &&
        field.fields.length > 0
      ) {
        flattenSchemaFields({
          schema: field.fields,
          prefix: `${path}[0]`,
          output,
        });
      }
    }
  }
}

export function getWebhookConditionFields(
  schema: WebhookSchemaField[]
): ConditionFieldDefinition[] {
  const fields: ConditionFieldDefinition[] = [];
  flattenSchemaFields({ schema, output: fields });

  const dedupedByPath = new Map<string, ConditionFieldDefinition>();
  for (const field of fields) {
    if (!dedupedByPath.has(field.path)) {
      dedupedByPath.set(field.path, field);
    }
  }

  return Array.from(dedupedByPath.values());
}
