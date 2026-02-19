export type WorkflowSchemaFieldType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object";

export type WorkflowSchemaItemType = "string" | "number" | "boolean" | "object";

export type WorkflowSchemaField = {
  name: string;
  type: WorkflowSchemaFieldType;
  itemType?: WorkflowSchemaItemType;
  fields?: WorkflowSchemaField[];
  format?: "timestamp";
  description?: string;
};

type JsonSchemaType = WorkflowSchemaFieldType | WorkflowSchemaItemType;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWorkflowSchemaFieldType(
  value: unknown
): value is WorkflowSchemaFieldType {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "array" ||
    value === "object"
  );
}

export function isWorkflowSchemaItemType(
  value: unknown
): value is WorkflowSchemaItemType {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "object"
  );
}

function normalizeJsonSchemaType(value: unknown): JsonSchemaType | null {
  if (typeof value === "string") {
    return isWorkflowSchemaFieldType(value) ? value : null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const firstSupportedType = value.find((item) =>
    isWorkflowSchemaFieldType(item)
  );
  return isWorkflowSchemaFieldType(firstSupportedType)
    ? firstSupportedType
    : null;
}

function normalizeSchemaFormat(value: unknown): WorkflowSchemaField["format"] {
  if (value === "date-time" || value === "datetime" || value === "timestamp") {
    return "timestamp";
  }

  return undefined;
}

export function parseWorkflowSchemaField(
  value: unknown
): WorkflowSchemaField | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) {
    return null;
  }

  const description =
    typeof value.description === "string" ? value.description : undefined;
  const normalizedType =
    normalizeJsonSchemaType(value.type) ||
    (Array.isArray(value.fields) ? "object" : null) ||
    (value.itemType !== undefined ? "array" : null) ||
    "string";

  if (normalizedType === "array") {
    const normalizedItemType = normalizeJsonSchemaType(value.itemType);
    const itemType = isWorkflowSchemaItemType(normalizedItemType)
      ? normalizedItemType
      : "string";

    const fields =
      itemType === "object" && Array.isArray(value.fields)
        ? value.fields.flatMap((field) => {
            const parsedField = parseWorkflowSchemaField(field);
            return parsedField ? [parsedField] : [];
          })
        : undefined;

    return {
      name,
      type: "array",
      itemType,
      fields,
      format:
        itemType === "string" ? normalizeSchemaFormat(value.format) : undefined,
      description,
    };
  }

  if (normalizedType === "object") {
    const fields = Array.isArray(value.fields)
      ? value.fields.flatMap((field) => {
          const parsedField = parseWorkflowSchemaField(field);
          return parsedField ? [parsedField] : [];
        })
      : [];

    return {
      name,
      type: "object",
      fields,
      description,
    };
  }

  return {
    name,
    type: normalizedType,
    format:
      normalizedType === "string"
        ? normalizeSchemaFormat(value.format)
        : undefined,
    description,
  };
}

export function parseWorkflowSchemaFields(
  value: unknown
): WorkflowSchemaField[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((field) => {
    const parsedField = parseWorkflowSchemaField(field);
    return parsedField ? [parsedField] : [];
  });
}

export function parseWorkflowSchemaFieldsString(
  value: string | undefined | null
): WorkflowSchemaField[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return parseWorkflowSchemaFields(parsed);
  } catch {
    return [];
  }
}

function parseJsonSchemaProperty(
  name: string,
  value: unknown
): WorkflowSchemaField | null {
  if (!isRecord(value)) {
    return null;
  }

  const normalizedType =
    normalizeJsonSchemaType(value.type) ||
    (value.properties ? "object" : null) ||
    (value.items ? "array" : null);

  if (!normalizedType) {
    return null;
  }

  const description =
    typeof value.description === "string" ? value.description : undefined;

  if (
    normalizedType === "string" ||
    normalizedType === "number" ||
    normalizedType === "boolean"
  ) {
    return {
      name,
      type: normalizedType,
      format:
        normalizedType === "string"
          ? normalizeSchemaFormat(value.format)
          : undefined,
      description,
    };
  }

  if (normalizedType === "object") {
    return {
      name,
      type: "object",
      fields: parseJsonSchemaProperties(value.properties),
      description,
    };
  }

  const items = isRecord(value.items) ? value.items : null;
  const normalizedItemType =
    normalizeJsonSchemaType(items?.type) ||
    (items?.properties ? "object" : null) ||
    "string";

  if (!isWorkflowSchemaItemType(normalizedItemType)) {
    return null;
  }

  return {
    name,
    type: "array",
    itemType: normalizedItemType,
    fields:
      normalizedItemType === "object"
        ? parseJsonSchemaProperties(items?.properties)
        : undefined,
    format:
      normalizedItemType === "string"
        ? normalizeSchemaFormat(items?.format)
        : undefined,
    description,
  };
}

function parseJsonSchemaProperties(value: unknown): WorkflowSchemaField[] {
  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([name, property]) => {
    const parsedProperty = parseJsonSchemaProperty(name, property);
    return parsedProperty ? [parsedProperty] : [];
  });
}

export function parseWorkflowSchemaFieldsOrJsonSchema(
  value: unknown
): WorkflowSchemaField[] | null {
  if (Array.isArray(value)) {
    return parseWorkflowSchemaFields(value);
  }

  if (!isRecord(value)) {
    return null;
  }

  const rootType =
    normalizeJsonSchemaType(value.type) || (value.properties ? "object" : null);

  if (rootType && rootType !== "object") {
    return null;
  }

  return parseJsonSchemaProperties(value.properties);
}

function workflowSchemaFieldToJsonSchemaNode(
  field: WorkflowSchemaField
): Record<string, unknown> {
  const base: Record<string, unknown> = {};

  if (field.description?.trim()) {
    base.description = field.description.trim();
  }

  if (
    field.type === "string" ||
    field.type === "number" ||
    field.type === "boolean"
  ) {
    return {
      ...base,
      type: field.type,
      ...(field.type === "string" && field.format === "timestamp"
        ? { format: "date-time" }
        : {}),
    };
  }

  if (field.type === "object") {
    return {
      ...base,
      type: "object",
      properties: workflowSchemaFieldsToJsonSchemaProperties(
        field.fields ?? []
      ),
    };
  }

  if (field.itemType === "object") {
    return {
      ...base,
      type: "array",
      items: {
        type: "object",
        properties: workflowSchemaFieldsToJsonSchemaProperties(
          field.fields ?? []
        ),
      },
    };
  }

  return {
    ...base,
    type: "array",
    items: {
      type: field.itemType ?? "string",
      ...(field.itemType === "string" && field.format === "timestamp"
        ? { format: "date-time" }
        : {}),
    },
  };
}

export function workflowSchemaFieldsToJsonSchemaProperties(
  schema: WorkflowSchemaField[]
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const field of schema) {
    const name = field.name.trim();
    if (!name) {
      continue;
    }

    properties[name] = workflowSchemaFieldToJsonSchemaNode(field);
  }

  return properties;
}

export function workflowSchemaFieldsToJsonSchemaDocument(
  schema: WorkflowSchemaField[]
): Record<string, unknown> {
  return {
    type: "object",
    properties: workflowSchemaFieldsToJsonSchemaProperties(schema),
  };
}
