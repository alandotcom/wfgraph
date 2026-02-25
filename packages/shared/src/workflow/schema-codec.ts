import { startCase } from "es-toolkit/string";
import type { ActionConfigFieldBase } from "@/plugins/registry";

/**
 * Library-specific options passed through StandardSchema's `libraryOptions`.
 * Arktype spreads these into `toJsonSchema()`. Other libraries ignore them.
 * Handles non-JSON-representable output types (Date, morphs, predicates).
 */
export const jsonSchemaLibraryOptions: Record<string, unknown> = {
  fallback: {
    date: (ctx: { base: Record<string, unknown> }) => ({
      ...ctx.base,
      type: "string",
      format: "date-time",
    }),
    morph: (ctx: {
      base: Record<string, unknown>;
      out: Record<string, unknown> | null;
    }) => ctx.out ?? ctx.base,
    predicate: (ctx: { base: Record<string, unknown> }) => ctx.base,
    default: (ctx: { base: Record<string, unknown> }) => ctx.base,
  },
};

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
  nullable?: boolean;
  enumValues?: string[];
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

function extractEnumValues(
  value: Record<string, unknown>
): string[] | undefined {
  if (!Array.isArray(value.enum)) {
    return undefined;
  }

  const values = value.enum
    .filter(
      (item: unknown) => typeof item === "string" || typeof item === "number"
    )
    .map(String);

  return values.length > 0 ? values : undefined;
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
  if (
    value === "date-time" ||
    value === "datetime" ||
    value === "date" ||
    value === "timestamp"
  ) {
    return "timestamp";
  }

  return undefined;
}

function isIsoDatePattern(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return value.startsWith("^([+-]?\\d{4}") && value.includes("0[1-9]|1[0-2]");
}

function isTimestampString(prop: Record<string, unknown>): boolean {
  return (
    normalizeSchemaFormat(prop.format) === "timestamp" ||
    isIsoDatePattern(prop.pattern)
  );
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

  const enumValues = Array.isArray(value.enumValues)
    ? value.enumValues
        .filter(
          (item: unknown) =>
            typeof item === "string" || typeof item === "number"
        )
        .map(String)
    : undefined;

  return {
    name,
    type: resolvePrimitiveWorkflowSchemaType({
      type: normalizedType,
      format: value.format,
    }),
    description,
    ...(enumValues && enumValues.length > 0 ? { enumValues } : {}),
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

function resolveConstBranches(
  nonNullBranches: unknown[],
  description: unknown
): Record<string, unknown> | null {
  const allConst = nonNullBranches.every(
    (b: unknown) => isRecord(b) && "const" in b
  );
  if (!allConst) {
    return null;
  }

  const constValues: string[] = [];
  for (const b of nonNullBranches) {
    if (
      isRecord(b) &&
      (typeof b.const === "string" || typeof b.const === "number")
    ) {
      constValues.push(String(b.const));
    }
  }

  const result: Record<string, unknown> = { type: "string" };
  if (constValues.length > 0) {
    result.enum = constValues;
  }
  if (typeof description === "string") {
    result.description = description;
  }
  return result;
}

/**
 * Resolve nullable JSON Schema unions (`anyOf`/`oneOf` containing a `{ type: "null" }` branch).
 * Returns the non-null branch (preserving top-level description) so the caller can
 * parse it as a normal typed property, or `null` if the shape isn't a recognizable
 * nullable union.
 */
function resolveNullableJsonSchema(
  value: Record<string, unknown>
): Record<string, unknown> | null {
  let branches: unknown[] | null = null;
  if (Array.isArray(value.anyOf)) {
    branches = value.anyOf;
  } else if (Array.isArray(value.oneOf)) {
    branches = value.oneOf;
  }

  if (!branches || branches.length < 2) {
    return null;
  }

  const nonNullBranches = branches.filter(
    (b: unknown) => isRecord(b) && b.type !== "null"
  );

  if (nonNullBranches.length === 0) {
    return null;
  }

  // Single non-null branch (e.g. `"string | null"` → `{ anyOf: [{type:"string"}, {type:"null"}] }`)
  if (nonNullBranches.length === 1 && isRecord(nonNullBranches[0])) {
    const branch = nonNullBranches[0];
    if (typeof value.description === "string" && !branch.description) {
      return { ...branch, description: value.description };
    }
    return branch;
  }

  // Multiple non-null `const` branches (e.g. `"'A' | 'B' | null"` → treat as string)
  return resolveConstBranches(nonNullBranches, value.description);
}

function parseNonNullableJsonSchemaProperty(
  name: string,
  value: Record<string, unknown>
): WorkflowSchemaField | null {
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
    const enumValues = extractEnumValues(value);
    return {
      name,
      type:
        normalizedType === "string" && isTimestampString(value)
          ? "timestamp"
          : normalizedType,
      description,
      ...(enumValues ? { enumValues } : {}),
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
  if (normalizedItemType === "string" && items && isTimestampString(items)) {
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

function parseJsonSchemaProperty(
  name: string,
  value: unknown
): WorkflowSchemaField | null {
  if (!isRecord(value)) {
    return null;
  }

  const resolved = resolveNullableJsonSchema(value);
  if (resolved) {
    const field = parseNonNullableJsonSchemaProperty(name, resolved);
    if (field) {
      field.nullable = true;
    }
    return field;
  }

  return parseNonNullableJsonSchemaProperty(name, value);
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

function deriveConfigFieldType(
  property: Record<string, unknown>
): ActionConfigFieldBase["type"] {
  if (Array.isArray(property.enum)) {
    return "select";
  }

  const type = typeof property.type === "string" ? property.type : undefined;

  switch (type) {
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "select";
    case "object":
      return "key-value";
    default:
      return "template-input";
  }
}

function deriveConfigFieldLabel(
  key: string,
  property: Record<string, unknown>
): string {
  return typeof property.description === "string" && property.description.trim()
    ? property.description.trim()
    : startCase(key);
}

function deriveSelectOptions(
  property: Record<string, unknown>
): ActionConfigFieldBase["options"] {
  if (Array.isArray(property.enum)) {
    return property.enum.map((v: unknown) => ({
      value: String(v),
      label: String(v),
    }));
  }
  return [
    { value: "true", label: "Yes" },
    { value: "false", label: "No" },
  ];
}

function jsonSchemaPropertyToConfigField(
  key: string,
  property: Record<string, unknown>,
  required: boolean
): ActionConfigFieldBase {
  const fieldType = deriveConfigFieldType(property);

  const field: ActionConfigFieldBase = {
    key,
    label: deriveConfigFieldLabel(key, property),
    type: fieldType,
  };

  if (required) {
    field.required = true;
  }

  if (property.default !== undefined) {
    field.defaultValue =
      typeof property.default === "string"
        ? property.default
        : JSON.stringify(property.default);
  }

  if (
    Array.isArray(property.examples) &&
    property.examples.length > 0 &&
    property.examples[0] !== undefined
  ) {
    field.example = String(property.examples[0]);
  }

  if (fieldType === "number" && typeof property.minimum === "number") {
    field.min = property.minimum;
  }

  if (fieldType === "select") {
    field.options = deriveSelectOptions(property);
  }

  return field;
}

export function configFieldsFromJsonSchema(
  jsonSchema: Record<string, unknown>
): ActionConfigFieldBase[] {
  const properties = isRecord(jsonSchema.properties)
    ? jsonSchema.properties
    : undefined;

  if (!properties) {
    return [];
  }

  const requiredSet = new Set(
    Array.isArray(jsonSchema.required) ? jsonSchema.required : []
  );

  return Object.entries(properties).flatMap(([key, value]) => {
    if (!isRecord(value)) {
      return [];
    }
    return [jsonSchemaPropertyToConfigField(key, value, requiredSet.has(key))];
  });
}
