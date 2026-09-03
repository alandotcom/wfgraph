import { Schema } from "effect";
import { compact, uniq } from "es-toolkit/array";
import { startCase } from "es-toolkit/string";
import type { ActionConfigFieldBase } from "#src/plugins/action-fields";
import { readAs } from "#src/types/schema";
import { omitUndefined } from "#src/utils/omit-undefined";

/**
 * Library-specific options passed through StandardSchema's `libraryOptions`.
 * Arktype spreads these into `toJsonSchema()`. Other libraries ignore them.
 * Handles non-JSON-representable output types (Date, morphs, predicates).
 */
export const jsonSchemaLibraryOptions: Record<string, unknown> = {
  fallback: {
    date: (context: { base: Record<string, unknown> }) => ({
      ...context.base,
      type: "string",
      format: "date-time",
    }),
    morph: (context: {
      base: Record<string, unknown>;
      out: Record<string, unknown> | null;
    }) => context.out ?? context.base,
    predicate: (context: { base: Record<string, unknown> }) => context.base,
    default: (context: { base: Record<string, unknown> }) => context.base,
  },
};

export type WorkflowSchemaFieldType =
  | "string"
  | "number"
  | "boolean"
  | "timestamp"
  | "duration"
  | "array"
  | "object";

export type WorkflowSchemaItemType =
  | "string"
  | "number"
  | "boolean"
  | "timestamp"
  | "duration"
  | "object";

export type WorkflowSchemaField = {
  name: string;
  type: WorkflowSchemaFieldType;
  itemType?: WorkflowSchemaItemType | undefined;
  /**
   * The type every value under an open record carries, the mirror of `itemType`
   * for an array. Present only on an object that accepts keys its schema does
   * not name, which is what makes an unlisted key addressable downstream.
   */
  valueType?: WorkflowSchemaItemType | undefined;
  fields?: WorkflowSchemaField[] | undefined;
  description?: string | undefined;
  nullable?: boolean | undefined;
  enumValues?: string[] | undefined;
  minItems?: number | undefined;
};

type JsonSchemaType = WorkflowSchemaFieldType | WorkflowSchemaItemType;

/**
 * A node of a JSON Schema document, holding only the keywords this module reads.
 *
 * A member is `undefined` when the document left it out and also when the
 * document had it in a shape this module cannot use.
 */
interface JsonSchemaNode {
  type?: string | string[] | undefined;
  format?: string | undefined;
  description?: string | undefined;
  enum?: unknown[] | undefined;
  const?: unknown;
  required?: string[] | undefined;
  default?: unknown;
  examples?: unknown[] | undefined;
  minimum?: number | undefined;
  minItems?: number | undefined;
  properties?: JsonSchemaProperties | undefined;
  /**
   * Present only when the document wrote the keyword. `false` closes the object;
   * `true` or a node opens it. An absent keyword is read as closed even though
   * JSON Schema defaults it to open, because a library that leaves it out has
   * said nothing about extra keys and offering `user.anything` off that silence
   * would fill the picker with paths no payload holds.
   */
  additionalProperties?: JsonSchemaNode | boolean | undefined;
  items?: JsonSchemaNode | undefined;
  anyOf?: (JsonSchemaNode | undefined)[] | undefined;
  oneOf?: (JsonSchemaNode | undefined)[] | undefined;
  allOf?: (JsonSchemaNode | undefined)[] | undefined;
}

/** A `properties` map, whose members drop out individually when malformed. */
type JsonSchemaProperties = Record<string, JsonSchemaNode | undefined>;

/**
 * A field of the schema dialect this project stores itself: a flat array of
 * named fields, which the schema builder in the editor writes and reads.
 */
interface WorkflowFieldRecord {
  name?: string | undefined;
  type?: string | string[] | undefined;
  itemType?: string | string[] | undefined;
  format?: string | undefined;
  description?: string | undefined;
  enumValues?: unknown[] | undefined;
  fields?: WorkflowFieldRecords | undefined;
}

/** A `fields` array, whose entries drop out individually when malformed. */
type WorkflowFieldRecords = (WorkflowFieldRecord | undefined)[];

/**
 * The leaf readers every keyword below goes through.
 *
 * A document arriving here was written by somebody else -- a saved schema
 * string, a JSON Schema an action's own library derived -- so no keyword can be
 * assumed to hold what its name suggests. `readAs` answers `undefined` for a
 * value that is not what the schema describes, which is what lets one broken
 * keyword drop out while the rest of the document still reads. That per-keyword
 * tolerance is why these are separate leaf reads rather than one struct: a
 * struct sinks every sibling alongside the member that failed.
 */
const readObject = readAs(Schema.Record(Schema.String, Schema.Unknown));
const readString = readAs(Schema.String);
// A foreign JSON Schema's `minimum` keyword carries whatever number its author
// wrote; narrowing to finite would reject a document this reader must still
// tolerate.
const readNumber = readAs(Schema.Number);
const readStringArray = readAs(Schema.mutable(Schema.Array(Schema.String)));
const readUnknownArray = readAs(Schema.mutable(Schema.Array(Schema.Unknown)));

/**
 * A `type` keyword, which JSON Schema allows to be one name or a list of names
 * (`{ type: ["null", "boolean"] }` for a nullable boolean).
 */
const readTypeName = readAs(
  Schema.Union([Schema.String, Schema.mutable(Schema.Array(Schema.String))])
);

/** Reads the members of an `anyOf`/`oneOf`/`allOf`, each one tolerated alone. */
function readNodeBranches(
  value: unknown,
  seen: WeakSet<object>
): (JsonSchemaNode | undefined)[] | undefined {
  const branches = readUnknownArray(value);
  return branches?.map((branch) => readJsonSchemaNode(branch, seen));
}

function readJsonSchemaProperties(
  value: unknown,
  seen: WeakSet<object>
): JsonSchemaProperties | undefined {
  const properties = readObject(value);
  if (!properties) {
    return undefined;
  }

  const out: JsonSchemaProperties = {};
  for (const [key, property] of Object.entries(properties)) {
    out[key] = readJsonSchemaNode(property, seen);
  }
  return out;
}

/**
 * An `additionalProperties` keyword: the boolean the document wrote, or the node
 * it wrote, or `undefined` when it wrote something this reader cannot use.
 */
function readAdditionalProperties(
  value: unknown,
  seen: WeakSet<object>
): JsonSchemaNode | boolean | undefined {
  return typeof value === "boolean" ? value : readJsonSchemaNode(value, seen);
}

/**
 * A JSON Schema node, or `undefined` when the value is not an object or when
 * this walk has already seen it.
 *
 * A cyclic in-memory document (two nodes pointing at each other, or a node at
 * itself through `properties` / `items` / a union branch) would otherwise
 * recurse until the stack overflowed. None of the three schema libraries in
 * the tree emit one -- Effect derives `{}` for `MutableJson`, Zod emits `$ref`
 * into `$defs` which this reader drops -- but a hand-built or hostile document
 * can, so identity is tracked and a second visit answers `undefined`.
 */
function readJsonSchemaNode(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): JsonSchemaNode | undefined {
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
  }

  const node = readObject(value);
  if (!node) {
    return undefined;
  }

  return {
    type: readTypeName(node.type),
    format: readString(node.format),
    description: readString(node.description),
    enum: readUnknownArray(node.enum),
    // oxlint-disable-next-line wfgraph/no-conditional-spread -- a closed-set collapse asks whether a branch declared `const` at all, and `{ const: null }` is a legal branch, so the key is carried over only when the document had it.
    ...(Object.hasOwn(node, "const") ? { const: node.const } : {}),
    required: readStringArray(node.required),
    default: node.default,
    examples: readUnknownArray(node.examples),
    minimum: readNumber(node.minimum),
    minItems: readNumber(node.minItems),
    properties: readJsonSchemaProperties(node.properties, seen),
    // oxlint-disable-next-line wfgraph/no-conditional-spread -- `additionalProperties` can legitimately be `false`, so the key is carried over only when the document had it.
    ...(Object.hasOwn(node, "additionalProperties")
      ? {
          additionalProperties: readAdditionalProperties(
            node.additionalProperties,
            seen
          ),
        }
      : {}),
    items: readJsonSchemaNode(node.items, seen),
    anyOf: readNodeBranches(node.anyOf, seen),
    oneOf: readNodeBranches(node.oneOf, seen),
    allOf: readNodeBranches(node.allOf, seen),
  };
}

function readWorkflowFieldRecords(
  value: unknown
): WorkflowFieldRecords | undefined {
  const records = readUnknownArray(value);
  return records?.map(readWorkflowFieldRecord);
}

function readWorkflowFieldRecord(
  value: unknown
): WorkflowFieldRecord | undefined {
  const record = readObject(value);
  if (!record) {
    return undefined;
  }

  return {
    name: readString(record.name),
    type: readTypeName(record.type),
    itemType: readTypeName(record.itemType),
    format: readString(record.format),
    description: readString(record.description),
    enumValues: readUnknownArray(record.enumValues),
    fields: readWorkflowFieldRecords(record.fields),
  };
}

export function isWorkflowSchemaFieldType(
  value: unknown
): value is WorkflowSchemaFieldType {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "timestamp" ||
    value === "duration" ||
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
    value === "duration" ||
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

/**
 * The JSON type every member shares, or null when the list is empty, mixed, or
 * holds something other than a string, number or boolean.
 */
function jsonTypeOfHomogeneousValues(
  values: unknown[] | undefined
): "string" | "number" | "boolean" | null {
  if (!values || values.length === 0) {
    return null;
  }

  const firstType = typeof values[0];
  if (
    (firstType !== "string" &&
      firstType !== "number" &&
      firstType !== "boolean") ||
    !values.every((value) => typeof value === firstType)
  ) {
    return null;
  }

  return firstType;
}

/** The closed set a node declares. `const` is JSON Schema's one-value `enum`. */
function declaredEnumOrConstValues(
  value: JsonSchemaNode
): unknown[] | undefined {
  if (value.enum) {
    return value.enum;
  }

  return "const" in value ? [value.const] : undefined;
}

/**
 * The type a node's own keywords name, before inferring one from an enum.
 * Mixed-union collapse uses this so an enum sibling is not mistaken for a type.
 */
function jsonSchemaTypeFromKeywords(
  value: JsonSchemaNode
): JsonSchemaType | null {
  return (
    normalizeJsonSchemaType(value.type) ||
    (value.properties ? "object" : null) ||
    (value.items ? "array" : null)
  );
}

function jsonPrimitiveTypeOf(
  schemaType: JsonSchemaType
): "string" | "number" | "boolean" | null {
  switch (schemaType) {
    case "string":
    case "timestamp":
    case "duration":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
    case "object":
      return null;
    default: {
      schemaType satisfies never;
      return null;
    }
  }
}

function normalizeSchemaFormat(
  value: string | undefined
): "timestamp" | "duration" | undefined {
  if (value === "date-time" || value === "datetime" || value === "timestamp") {
    return "timestamp";
  }

  // JSON Schema's own keyword for an ISO 8601 length of time, which is the only
  // spelling: `duration` is what Zod, arktype and `durationString` all emit.
  if (value === "duration") {
    return "duration";
  }

  return undefined;
}

/**
 * Whether a string property names a moment in time.
 *
 * A `format` keyword is the whole of the evidence. It sits flat on the property
 * in a document Zod or arktype derived, and Effect hangs everything a
 * `.check(...)` contributed off `allOf`, so the walk looks one level down as
 * well: an author who annotated inside a check still gets the field read as a
 * timestamp.
 *
 * A schema that wants its dates recognised has to carry the keyword. Zod emits
 * it from `z.iso.datetime()` and arktype through the `fallback.date` option
 * above; Effect emits none, for `Schema.Date` and `Schema.DateFromString` alike,
 * so an Effect author annotates the string themselves (Effect-TS/effect#6790).
 */
function isTimestampString(prop: JsonSchemaNode): boolean {
  if (normalizeSchemaFormat(prop.format) === "timestamp") {
    return true;
  }

  return compact(prop.allOf ?? []).some(isTimestampString);
}

/** Whether a string property names a length of time, read as `isTimestampString`. */
function isDurationString(prop: JsonSchemaNode): boolean {
  if (normalizeSchemaFormat(prop.format) === "duration") {
    return true;
  }

  return compact(prop.allOf ?? []).some(isDurationString);
}

/**
 * Which of the two meanings a JSON Schema string carries, or undefined for one
 * that is just text. Both are strings on the wire and the `format` keyword is
 * the whole of what tells them apart.
 */
function stringSubtype(
  prop: JsonSchemaNode
): "timestamp" | "duration" | undefined {
  if (isTimestampString(prop)) {
    return "timestamp";
  }

  return isDurationString(prop) ? "duration" : undefined;
}

/** The `format` a type is written back out under, absent for a plain type. */
function stringFormatFor(
  type: WorkflowSchemaFieldType | WorkflowSchemaItemType | undefined
): "date-time" | "duration" | undefined {
  if (type === "timestamp") {
    return "date-time";
  }

  return type === "duration" ? "duration" : undefined;
}

function workflowSchemaItemTypeToJsonSchemaNode(
  type: WorkflowSchemaItemType
): Record<string, unknown> {
  const format = stringFormatFor(type);
  return omitUndefined({
    type: format ? "string" : type,
    format,
  });
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
  const format = normalizeSchemaFormat(input.format);
  if (input.type === "string" && format) {
    return format;
  }

  return input.type;
}

function arrayWorkflowSchemaFieldFromRecord(input: {
  name: string;
  record: WorkflowFieldRecord;
  description?: string | undefined;
}): WorkflowSchemaField {
  const { name, record, description } = input;
  const normalizedItemType = normalizeJsonSchemaType(record.itemType);
  const normalizedFormat = normalizeSchemaFormat(record.format);
  let itemType: WorkflowSchemaItemType = "string";
  if (isWorkflowSchemaItemType(normalizedItemType)) {
    itemType = normalizedItemType;
  }
  if (itemType === "string" && normalizedFormat) {
    itemType = normalizedFormat;
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
    enumValues,
  };
}

export function parseWorkflowSchemaField(
  value: unknown
): WorkflowSchemaField | null {
  const record = readWorkflowFieldRecord(value);
  return record ? workflowSchemaFieldFromRecord(record) : null;
}

export function parseWorkflowSchemaFields(
  value: unknown
): WorkflowSchemaField[] {
  return workflowSchemaFieldsFromRecords(readWorkflowFieldRecords(value));
}

function withInheritedAnnotations(
  branch: JsonSchemaNode,
  parent: JsonSchemaNode
): JsonSchemaNode {
  const result: JsonSchemaNode = { ...branch };
  if (parent.description !== undefined && !result.description) {
    result.description = parent.description;
  }
  if (parent.format !== undefined && result.format === undefined) {
    result.format = parent.format;
  }
  return result;
}

/**
 * Homogeneous `enum`/`const` branches of one JSON type, collapsed into a closed
 * set. Effect's `Schema.Enum` is one string enum per member rather than one
 * `enum` array; arktype and Zod const unions are the same idea with `const`.
 */
function resolveClosedSetBranches(
  nonNullBranches: JsonSchemaNode[],
  parent: JsonSchemaNode
): JsonSchemaNode | null {
  const values: unknown[] = [];
  let jsonType: "string" | "number" | "boolean" | null = null;

  for (const branch of nonNullBranches) {
    const declared = declaredEnumOrConstValues(branch);
    const memberType = jsonTypeOfHomogeneousValues(declared);
    if (!declared || !memberType) {
      return null;
    }

    const keywordType = jsonSchemaTypeFromKeywords(branch);
    if (keywordType && jsonPrimitiveTypeOf(keywordType) !== memberType) {
      return null;
    }

    if (jsonType !== null && jsonType !== memberType) {
      return null;
    }
    jsonType = memberType;
    values.push(...declared);
  }

  if (!jsonType) {
    return null;
  }

  return withInheritedAnnotations(
    { type: jsonType, enum: uniq(values) },
    parent
  );
}

/**
 * A typed branch beside `const` siblings of the same JSON type.
 *
 * arktype's `string.uuid` is a pattern plus the nil and max UUID, which fail
 * the pattern. The consts are extra values of an open type, not a closed set.
 */
function resolveTypedAndConstBranches(
  nonNullBranches: JsonSchemaNode[],
  parent: JsonSchemaNode
): JsonSchemaNode | null {
  const typed: JsonSchemaNode[] = [];
  const consts: JsonSchemaNode[] = [];
  for (const branch of nonNullBranches) {
    if ("const" in branch) {
      consts.push(branch);
      continue;
    }
    if (jsonSchemaTypeFromKeywords(branch)) {
      typed.push(branch);
      continue;
    }
    return null;
  }

  const branch = typed[0];
  if (!branch || typed.length !== 1 || consts.length === 0) {
    return null;
  }

  const branchType = jsonSchemaTypeFromKeywords(branch);
  const constType = jsonTypeOfHomogeneousValues(
    consts.map((item) => item.const)
  );
  if (
    !branchType ||
    !constType ||
    jsonPrimitiveTypeOf(branchType) !== constType
  ) {
    return null;
  }

  return withInheritedAnnotations(branch, parent);
}

type ResolvedJsonSchemaUnion = {
  node: JsonSchemaNode;
  nullable: boolean;
};

/**
 * Collapse an `anyOf`/`oneOf` into one typed node the rest of the reader can
 * parse. `nullable` is whether a `{ type: "null" }` branch was among them, not
 * whether there was more than one branch.
 */
function resolveJsonSchemaUnion(
  value: JsonSchemaNode
): ResolvedJsonSchemaUnion | null {
  const branches = value.anyOf ?? value.oneOf;

  if (!branches || branches.length < 2) {
    return null;
  }

  const present = compact(branches);
  const nullable = present.some((branch) => branch.type === "null");
  const nonNullBranches = present.filter((branch) => branch.type !== "null");

  if (nonNullBranches.length === 0) {
    return null;
  }

  if (nonNullBranches.length === 1) {
    const branch = nonNullBranches[0];
    if (!branch) {
      return null;
    }
    return { node: withInheritedAnnotations(branch, value), nullable };
  }

  const fromClosed = resolveClosedSetBranches(nonNullBranches, value);
  if (fromClosed) {
    return { node: fromClosed, nullable };
  }

  const fromMixed = resolveTypedAndConstBranches(nonNullBranches, value);
  if (fromMixed) {
    return { node: fromMixed, nullable };
  }

  return null;
}

/**
 * The type an open record's values carry, or null when the object is closed.
 *
 * `Schema.Record(Schema.String, Schema.String)` describes itself as
 * `{ type: "object", additionalProperties: { type: "string" } }` and names no
 * properties, so this keyword is the only evidence that a key the schema never
 * listed is still a real path.
 *
 * An opening that declares no type answers nothing rather than guessing text.
 * The type is what a condition compares against, so guessing it wrong offers a
 * record of numbers as a text rule and compiles a string comparison against a
 * number. An array's untyped item defaults to text instead, which is safe there
 * because nothing compares an array element directly.
 */
function openRecordValueType(
  additional: JsonSchemaNode | boolean | undefined
): WorkflowSchemaItemType | undefined {
  if (additional === undefined || typeof additional === "boolean") {
    return undefined;
  }

  const declared =
    normalizeJsonSchemaType(additional.type) ||
    (additional.properties ? "object" : null);
  if (!declared) {
    return undefined;
  }

  const valueType =
    declared === "string" ? (stringSubtype(additional) ?? declared) : declared;

  return isWorkflowSchemaItemType(valueType) ? valueType : undefined;
}

function parseNonNullableJsonSchemaProperty(
  name: string,
  value: JsonSchemaNode
): WorkflowSchemaField | null {
  const declaredValues = declaredEnumOrConstValues(value);
  const normalizedType =
    jsonSchemaTypeFromKeywords(value) ||
    jsonTypeOfHomogeneousValues(declaredValues);

  if (!normalizedType) {
    return null;
  }

  const description = value.description;

  if (
    normalizedType === "string" ||
    normalizedType === "number" ||
    normalizedType === "boolean" ||
    normalizedType === "timestamp" ||
    normalizedType === "duration"
  ) {
    const enumValues =
      normalizedType === "string" ? toEnumValues(declaredValues) : undefined;
    return {
      name,
      type:
        normalizedType === "string"
          ? (stringSubtype(value) ?? normalizedType)
          : normalizedType,
      description,
      enumValues,
    };
  }

  if (normalizedType === "object") {
    return {
      name,
      type: "object",
      fields: parseJsonSchemaProperties(value.properties, value.required),
      description,
      valueType: openRecordValueType(value.additionalProperties),
    };
  }

  const items = value.items;
  let normalizedItemType =
    normalizeJsonSchemaType(items?.type) ||
    (items?.properties ? "object" : null) ||
    "string";
  if (normalizedItemType === "string" && items) {
    normalizedItemType = stringSubtype(items) ?? normalizedItemType;
  }

  if (!isWorkflowSchemaItemType(normalizedItemType)) {
    return null;
  }

  const minItems =
    value.minItems !== undefined &&
    Number.isFinite(value.minItems) &&
    value.minItems >= 0
      ? value.minItems
      : undefined;

  return {
    name,
    type: "array",
    itemType: normalizedItemType,
    fields:
      normalizedItemType === "object"
        ? parseJsonSchemaProperties(items?.properties, items?.required)
        : undefined,
    description,
    minItems,
  };
}

/** Nested `anyOf` depth this reader will unwrap, e.g. `NullOr` around `Schema.Enum`. */
const MAX_JSON_SCHEMA_UNION_DEPTH = 3;

function parseJsonSchemaProperty(
  name: string,
  value: JsonSchemaNode,
  depth = 0
): WorkflowSchemaField | null {
  if (depth > MAX_JSON_SCHEMA_UNION_DEPTH) {
    return parseNonNullableJsonSchemaProperty(name, value);
  }

  const resolved = resolveJsonSchemaUnion(value);
  if (resolved) {
    const field = parseJsonSchemaProperty(name, resolved.node, depth + 1);
    return field && markNullable(field, resolved.nullable);
  }

  return parseNonNullableJsonSchemaProperty(name, value);
}

/**
 * `nullable` is a disjunction: any one way for the value to go missing sets it,
 * and none of them clears it. A null branch in a union, a name the parent's
 * `required` leaves out, and an absent ancestor are the three ways, and the
 * third is applied by the walk in `node-references.ts`.
 */
function markNullable(
  field: WorkflowSchemaField,
  nullable: boolean
): WorkflowSchemaField {
  return nullable ? { ...field, nullable: true } : field;
}

/**
 * The fields one object's `properties` describe, given the `required` list that
 * says which of them a payload always carries.
 *
 * A property the list leaves out is marked `nullable`, which is that flag's
 * absent-key case: `Schema.optionalKey(...)` reaches here as a property whose
 * name is missing from `required` and which carries no null branch, so reading
 * the keyword is the only thing that tells it apart from a guaranteed field.
 *
 * An absent `required` is read as JSON Schema defines it, meaning no property is
 * required, which is the same reading `configFieldsFromJsonSchema` takes of the
 * keyword.
 */
function parseJsonSchemaProperties(
  properties: JsonSchemaProperties | undefined,
  required: string[] | undefined
): WorkflowSchemaField[] {
  if (!properties) {
    return [];
  }

  const requiredNames = new Set(required ?? []);

  return Object.entries(properties).flatMap(([name, property]) => {
    const field = property ? parseJsonSchemaProperty(name, property) : null;
    return field ? [markNullable(field, !requiredNames.has(name))] : [];
  });
}

export function parseWorkflowSchemaFieldsOrJsonSchema(
  value: unknown
): WorkflowSchemaField[] | null {
  if (Array.isArray(value)) {
    return parseWorkflowSchemaFields(value);
  }

  const document = readJsonSchemaNode(value);
  if (!document) {
    return null;
  }

  const rootType =
    normalizeJsonSchemaType(document.type) ||
    (document.properties ? "object" : null);

  if (rootType && rootType !== "object") {
    return null;
  }

  return parseJsonSchemaProperties(document.properties, document.required);
}

/**
 * Write one field back out as a JSON Schema node.
 *
 * Every emitted node goes through `omitUndefined`, because the reader answers
 * `format` and `additionalProperties` from whether the key is there at all: a
 * key present and holding `undefined` would read as a declared one.
 */
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
    field.type === "timestamp" ||
    field.type === "duration"
  ) {
    const format = stringFormatFor(field.type);
    return omitUndefined({
      ...base,
      type: format ? "string" : field.type,
      format,
    });
  }

  if (field.type === "object") {
    return omitUndefined({
      ...base,
      type: "object",
      properties: workflowSchemaFieldsToJsonSchemaProperties(
        field.fields ?? []
      ),
      ...requiredNamesOf(field.fields ?? []),
      additionalProperties: field.valueType
        ? workflowSchemaItemTypeToJsonSchemaNode(field.valueType)
        : undefined,
    });
  }

  if (field.itemType === "object") {
    return omitUndefined({
      ...base,
      type: "array",
      items: {
        type: "object",
        properties: workflowSchemaFieldsToJsonSchemaProperties(
          field.fields ?? []
        ),
        ...requiredNamesOf(field.fields ?? []),
      },
    });
  }

  const itemFormat = stringFormatFor(field.itemType);
  return omitUndefined({
    ...base,
    type: "array",
    items: omitUndefined({
      type: itemFormat ? "string" : (field.itemType ?? "string"),
      format: itemFormat,
    }),
  });
}

/**
 * The `required` keyword for these fields, or nothing when none is guaranteed.
 *
 * The reader treats a name missing from `required` as a field a payload can
 * arrive without, so an encode that never wrote the keyword would read back with
 * every field nullable. Omitting it where nothing is required says the same
 * thing the reader concludes, so the pair round-trips either way.
 */
function requiredNamesOf(fields: WorkflowSchemaField[]): {
  required?: string[];
} {
  const names = fields
    .filter((field) => field.nullable !== true)
    .map((field) => field.name.trim())
    .filter((name) => name.length > 0);

  return names.length > 0 ? { required: names } : {};
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
    ...requiredNamesOf(schema),
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

/**
 * What a key is called on screen: the author's description, or the key itself
 * title-cased when they wrote none.
 *
 * A surface that has to name every key derives its label here. A surface with
 * room for silence, such as the template picker's second line, reads the
 * author's description straight off the field instead.
 */
export function labelFromKey(key: string, description?: string): string {
  return description?.trim() ? description.trim() : startCase(key);
}

function deriveSelectOptions(
  property: JsonSchemaNode
): NonNullable<ActionConfigFieldBase["options"]> {
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

function resolveConfigFieldProperty(
  property: JsonSchemaNode,
  depth = 0
): JsonSchemaNode {
  if (depth > MAX_JSON_SCHEMA_UNION_DEPTH) {
    return property;
  }

  const resolved = resolveJsonSchemaUnion(property);
  return resolved
    ? resolveConfigFieldProperty(resolved.node, depth + 1)
    : property;
}

function jsonSchemaPropertyToConfigField(
  key: string,
  property: JsonSchemaNode,
  required: boolean
): ActionConfigFieldBase {
  const resolvedProperty = resolveConfigFieldProperty(property);
  const fieldType = deriveConfigFieldType(resolvedProperty);

  const field: ActionConfigFieldBase = {
    key,
    label: labelFromKey(key, property.description),
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
    field.options = deriveSelectOptions(resolvedProperty);
  }

  return field;
}

/**
 * `Record<string, unknown>` is the parameter type because that is what
 * Standard Schema's `jsonSchema.output()` hands back, so the document is read
 * here to reach its keywords with types attached.
 */
export function configFieldsFromJsonSchema(
  jsonSchema: Record<string, unknown>
): ActionConfigFieldBase[] {
  const document = readJsonSchemaNode(jsonSchema);
  if (!document) {
    return [];
  }

  const { properties, required } = document;
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
