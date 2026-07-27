import { compact } from "es-toolkit/array";
import { startCase } from "es-toolkit/string";
import { z } from "zod";
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

/**
 * A `type` keyword, which JSON Schema allows to be one name or a list of names
 * (`{ type: ["null", "boolean"] }` for a nullable boolean).
 */
const typeNameSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .catch(undefined);

const optionalString = z.string().optional().catch(undefined);

/**
 * Any JSON value is allowed in these slots, so the members below keep them as
 * `unknown` and the readers pick out the shapes they can use.
 */
const jsonValueSchema = z.unknown().optional().catch(undefined);
const jsonValueArraySchema = z.array(z.unknown()).optional().catch(undefined);

/**
 * A node of a JSON Schema document, holding only the keywords this module reads.
 * Recursive members are written out by hand because a schema that refers to
 * itself gives TypeScript nothing to infer from; the annotation on
 * `jsonSchemaNodeSchema` below ties the two together.
 *
 * A member is `undefined` when the document left it out and also when the
 * document had it in a shape this module cannot use.
 */
interface JsonSchemaNode {
  type?: string | string[];
  format?: string;
  pattern?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  default?: unknown;
  examples?: unknown[];
  minimum?: number;
  properties?: JsonSchemaProperties;
  items?: JsonSchemaNode;
  anyOf?: (JsonSchemaNode | undefined)[];
  oneOf?: (JsonSchemaNode | undefined)[];
}

/** A `properties` map, whose members drop out individually when malformed. */
type JsonSchemaProperties = Record<string, JsonSchemaNode | undefined>;

/**
 * `looseObject` keeps every keyword the shape below does not name, so parsing a
 * document does not quietly strip parts of it.
 *
 * Every member is `.optional().catch(undefined)`, which is what makes a saved
 * schema with one broken member still readable: the broken member alone comes
 * back as absent and the rest of the document parses. Recursive members are
 * declared as getters so the schema can refer to itself.
 */
const jsonSchemaNodeSchema: z.ZodType<JsonSchemaNode> = z.looseObject({
  type: typeNameSchema,
  format: optionalString,
  pattern: optionalString,
  description: optionalString,
  enum: jsonValueArraySchema,
  const: jsonValueSchema,
  required: z.array(z.string()).optional().catch(undefined),
  default: jsonValueSchema,
  examples: jsonValueArraySchema,
  minimum: z.number().optional().catch(undefined),
  get properties() {
    return z
      .record(z.string(), jsonSchemaNodeSchema.optional().catch(undefined))
      .optional()
      .catch(undefined);
  },
  get items() {
    return jsonSchemaNodeSchema.optional().catch(undefined);
  },
  get anyOf() {
    return z
      .array(jsonSchemaNodeSchema.optional().catch(undefined))
      .optional()
      .catch(undefined);
  },
  get oneOf() {
    return z
      .array(jsonSchemaNodeSchema.optional().catch(undefined))
      .optional()
      .catch(undefined);
  },
});

/**
 * A field of the schema dialect this project stores itself: a flat array of
 * named fields, which the schema builder in the editor writes and reads.
 */
interface WorkflowFieldRecord {
  name?: string;
  type?: string | string[];
  itemType?: string | string[];
  format?: string;
  description?: string;
  enumValues?: unknown[];
  fields?: WorkflowFieldRecords;
}

/** A `fields` array, whose entries drop out individually when malformed. */
type WorkflowFieldRecords = (WorkflowFieldRecord | undefined)[];

/** Tolerance and recursion work the same way as the JSON Schema node above. */
const workflowFieldRecordSchema: z.ZodType<WorkflowFieldRecord> = z.looseObject(
  {
    name: optionalString,
    type: typeNameSchema,
    itemType: typeNameSchema,
    format: optionalString,
    description: optionalString,
    enumValues: jsonValueArraySchema,
    get fields() {
      return z
        .array(workflowFieldRecordSchema.optional().catch(undefined))
        .optional()
        .catch(undefined);
    },
  }
);

const workflowFieldRecordArraySchema = z.array(
  workflowFieldRecordSchema.optional().catch(undefined)
);

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

/** Enum members that can be shown as choices: strings and numbers. */
function toEnumValues(values: unknown[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const enumValues = values
    .filter(
      (item: unknown) => typeof item === "string" || typeof item === "number"
    )
    .map(String);

  return enumValues.length > 0 ? enumValues : undefined;
}

function normalizeJsonSchemaType(
  value: string | string[] | undefined
): JsonSchemaType | null {
  if (typeof value === "string") {
    return isWorkflowSchemaFieldType(value) ? value : null;
  }

  if (!value) {
    return null;
  }

  return value.find(isWorkflowSchemaFieldType) ?? null;
}

function normalizeSchemaFormat(
  value: string | undefined
): "timestamp" | undefined {
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

function isIsoDatePattern(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value.startsWith("^([+-]?\\d{4}") && value.includes("0[1-9]|1[0-2]");
}

function isTimestampString(prop: JsonSchemaNode): boolean {
  return (
    normalizeSchemaFormat(prop.format) === "timestamp" ||
    isIsoDatePattern(prop.pattern)
  );
}

function workflowSchemaFieldsFromRecords(
  records: WorkflowFieldRecords | undefined
): WorkflowSchemaField[] {
  if (!records) {
    return [];
  }

  return records.flatMap((record) => {
    const field = record ? workflowSchemaFieldFromRecord(record) : null;
    return field ? [field] : [];
  });
}

function resolvePrimitiveWorkflowSchemaType(input: {
  type: JsonSchemaType;
  format: string | undefined;
}): WorkflowSchemaFieldType {
  if (
    input.type === "string" &&
    normalizeSchemaFormat(input.format) === "timestamp"
  ) {
    return "timestamp";
  }

  return input.type;
}

function arrayWorkflowSchemaFieldFromRecord(input: {
  name: string;
  record: WorkflowFieldRecord;
  description?: string;
}): WorkflowSchemaField {
  const { name, record, description } = input;
  const normalizedItemType = normalizeJsonSchemaType(record.itemType);
  const normalizedFormat = normalizeSchemaFormat(record.format);
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
        ? workflowSchemaFieldsFromRecords(record.fields)
        : undefined,
    description,
  };
}

function workflowSchemaFieldFromRecord(
  record: WorkflowFieldRecord
): WorkflowSchemaField | null {
  const name = record.name?.trim() ?? "";
  if (!name) {
    return null;
  }

  const description = record.description;
  const normalizedType =
    normalizeJsonSchemaType(record.type) ||
    (record.fields ? "object" : null) ||
    (record.itemType !== undefined ? "array" : null) ||
    "string";

  if (normalizedType === "array") {
    return arrayWorkflowSchemaFieldFromRecord({
      name,
      record,
      description,
    });
  }

  if (normalizedType === "object") {
    return {
      name,
      type: "object",
      fields: workflowSchemaFieldsFromRecords(record.fields),
      description,
    };
  }

  const enumValues = toEnumValues(record.enumValues);

  return {
    name,
    type: resolvePrimitiveWorkflowSchemaType({
      type: normalizedType,
      format: record.format,
    }),
    description,
    ...(enumValues ? { enumValues } : {}),
  };
}

export function parseWorkflowSchemaField(
  value: unknown
): WorkflowSchemaField | null {
  const parsed = workflowFieldRecordSchema.safeParse(value);
  return parsed.success ? workflowSchemaFieldFromRecord(parsed.data) : null;
}

export function parseWorkflowSchemaFields(
  value: unknown
): WorkflowSchemaField[] {
  const parsed = workflowFieldRecordArraySchema.safeParse(value);
  return parsed.success ? workflowSchemaFieldsFromRecords(parsed.data) : [];
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
  nonNullBranches: JsonSchemaNode[],
  description: string | undefined
): JsonSchemaNode | null {
  const allConst = nonNullBranches.every((branch) => "const" in branch);
  if (!allConst) {
    return null;
  }

  const constValues = toEnumValues(
    nonNullBranches.map((branch) => branch.const)
  );

  const result: JsonSchemaNode = { type: "string" };
  if (constValues) {
    result.enum = constValues;
  }
  if (description !== undefined) {
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
  value: JsonSchemaNode
): JsonSchemaNode | null {
  const branches = value.anyOf ?? value.oneOf;

  if (!branches || branches.length < 2) {
    return null;
  }

  const nonNullBranches = compact(branches).filter(
    (branch) => branch.type !== "null"
  );

  if (nonNullBranches.length === 0) {
    return null;
  }

  // Single non-null branch (e.g. `"string | null"` → `{ anyOf: [{type:"string"}, {type:"null"}] }`)
  if (nonNullBranches.length === 1) {
    const branch = nonNullBranches[0];
    if (value.description !== undefined && !branch.description) {
      return { ...branch, description: value.description };
    }
    return branch;
  }

  // Multiple non-null `const` branches (e.g. `"'A' | 'B' | null"` → treat as string)
  return resolveConstBranches(nonNullBranches, value.description);
}

function parseNonNullableJsonSchemaProperty(
  name: string,
  value: JsonSchemaNode
): WorkflowSchemaField | null {
  const normalizedType =
    normalizeJsonSchemaType(value.type) ||
    (value.properties ? "object" : null) ||
    (value.items ? "array" : null);

  if (!normalizedType) {
    return null;
  }

  const description = value.description;

  if (
    normalizedType === "string" ||
    normalizedType === "number" ||
    normalizedType === "boolean" ||
    normalizedType === "timestamp"
  ) {
    const enumValues = toEnumValues(value.enum);
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

  const items = value.items;
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
  value: JsonSchemaNode
): WorkflowSchemaField | null {
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

function parseJsonSchemaProperties(
  properties: JsonSchemaProperties | undefined
): WorkflowSchemaField[] {
  if (!properties) {
    return [];
  }

  return Object.entries(properties).flatMap(([name, property]) => {
    const parsedProperty = property
      ? parseJsonSchemaProperty(name, property)
      : null;
    return parsedProperty ? [parsedProperty] : [];
  });
}

export function parseWorkflowSchemaFieldsOrJsonSchema(
  value: unknown
): WorkflowSchemaField[] | null {
  if (Array.isArray(value)) {
    return parseWorkflowSchemaFields(value);
  }

  const parsed = jsonSchemaNodeSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  const document = parsed.data;
  const rootType =
    normalizeJsonSchemaType(document.type) ||
    (document.properties ? "object" : null);

  if (rootType && rootType !== "object") {
    return null;
  }

  return parseJsonSchemaProperties(document.properties);
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
  property: JsonSchemaNode
): ActionConfigFieldBase["type"] {
  if (property.enum) {
    return "select";
  }

  // A `type` list (`["string", "null"]`) carries no single form control, so it
  // falls through to the default below.
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

function deriveConfigFieldLabel(key: string, property: JsonSchemaNode): string {
  return property.description?.trim()
    ? property.description.trim()
    : startCase(key);
}

function deriveSelectOptions(
  property: JsonSchemaNode
): ActionConfigFieldBase["options"] {
  if (property.enum) {
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
  property: JsonSchemaNode,
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

  // An example is any JSON value, so it is rendered the same way as a default.
  const [firstExample] = property.examples ?? [];
  if (firstExample !== undefined) {
    field.example =
      typeof firstExample === "string"
        ? firstExample
        : JSON.stringify(firstExample);
  }

  if (fieldType === "number" && property.minimum !== undefined) {
    field.min = property.minimum;
  }

  if (fieldType === "select") {
    field.options = deriveSelectOptions(property);
  }

  return field;
}

/**
 * `Record<string, unknown>` is the parameter type because that is what
 * Standard Schema's `jsonSchema.output()` hands back, so the document is parsed
 * here to reach its keywords with types attached.
 */
export function configFieldsFromJsonSchema(
  jsonSchema: Record<string, unknown>
): ActionConfigFieldBase[] {
  const parsed = jsonSchemaNodeSchema.safeParse(jsonSchema);
  if (!parsed.success) {
    return [];
  }

  const { properties, required } = parsed.data;
  if (!properties) {
    return [];
  }

  const requiredSet = new Set(required ?? []);

  return Object.entries(properties).flatMap(([key, property]) =>
    property
      ? [jsonSchemaPropertyToConfigField(key, property, requiredSet.has(key))]
      : []
  );
}
