export type WorkflowSchemaFieldType =
  | "string"
  | "number"
  | "boolean"
  | "timestamp"
  | "array"
  | "object";

export type WorkflowSchemaItemType =
  | "string"
  | "number"
  | "boolean"
  | "timestamp"
  | "object";

export type WorkflowSchemaField = {
  name: string;
  type: WorkflowSchemaFieldType;
  itemType?: WorkflowSchemaItemType;
  fields?: WorkflowSchemaField[];
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
    value === "timestamp" ||
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
    value === "timestamp" ||
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

function normalizeSchemaFormat(value: unknown): "timestamp" | undefined {
  if (value === "date-time" || value === "datetime" || value === "timestamp") {
    return "timestamp";
  }

  return undefined;
}

function parseNestedWorkflowSchemaFields(
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

function resolvePrimitiveWorkflowSchemaType(input: {
  type: JsonSchemaType;
  format: unknown;
}): WorkflowSchemaFieldType {
  if (
    input.type === "string" &&
    normalizeSchemaFormat(input.format) === "timestamp"
  ) {
    return "timestamp";
  }

  return input.type;
}

function parseArrayWorkflowSchemaField(input: {
  name: string;
  value: Record<string, unknown>;
  description?: string;
}): WorkflowSchemaField {
  const { name, value, description } = input;
  const normalizedItemType = normalizeJsonSchemaType(value.itemType);
  const normalizedFormat = normalizeSchemaFormat(value.format);
  let itemType: WorkflowSchemaItemType = "string";
  if (isWorkflowSchemaItemType(normalizedItemType)) {
    itemType = normalizedItemType;
  }
  if (itemType === "string" && normalizedFormat === "timestamp") {
    itemType = "timestamp";
  }

  return {
    name,
    type: "array",
    itemType,
    fields:
      itemType === "object"
        ? parseNestedWorkflowSchemaFields(value.fields)
        : undefined,
    description,
  };
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
    return parseArrayWorkflowSchemaField({
      name,
      value,
      description,
    });
  }

  if (normalizedType === "object") {
    return {
      name,
      type: "object",
      fields: parseNestedWorkflowSchemaFields(value.fields),
      description,
    };
  }

  return {
    name,
    type: resolvePrimitiveWorkflowSchemaType({
      type: normalizedType,
      format: value.format,
    }),
    description,
  };
}

export function parseWorkflowSchemaFields(
  value: unknown
): WorkflowSchemaField[] {
  return parseNestedWorkflowSchemaFields(value);
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
    normalizedType === "boolean" ||
    normalizedType === "timestamp"
  ) {
    return {
      name,
      type:
        normalizedType === "string" &&
        normalizeSchemaFormat(value.format) === "timestamp"
          ? "timestamp"
          : normalizedType,
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
  let normalizedItemType =
    normalizeJsonSchemaType(items?.type) ||
    (items?.properties ? "object" : null) ||
    "string";
  if (
    normalizedItemType === "string" &&
    normalizeSchemaFormat(items?.format) === "timestamp"
  ) {
    normalizedItemType = "timestamp";
  }

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
    field.type === "boolean" ||
    field.type === "timestamp"
  ) {
    return {
      ...base,
      type: field.type === "timestamp" ? "string" : field.type,
      ...(field.type === "timestamp" ? { format: "date-time" } : {}),
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
      type:
        field.itemType === "timestamp"
          ? "string"
          : (field.itemType ?? "string"),
      ...(field.itemType === "timestamp" ? { format: "date-time" } : {}),
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
