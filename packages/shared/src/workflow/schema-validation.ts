import { Result, Schema } from "effect";
import { formatSchemaFailure } from "#src/types/schema-message";
import {
  parseWorkflowSchemaFieldsOrJsonSchema,
  type WorkflowSchemaField,
} from "#src/workflow/schema-codec";

type WorkflowSchemaParseResult =
  | { ok: true; schema: WorkflowSchemaField[]; configured: boolean }
  | { ok: false; error: string };

function toSchemaConfigString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseWorkflowSchemaString(value: unknown): WorkflowSchemaParseResult {
  const schemaString = toSchemaConfigString(value);
  if (!schemaString) {
    return { ok: true, configured: false, schema: [] };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(schemaString);
  } catch {
    return { ok: false, error: "Schema is not valid JSON." };
  }

  const schema = parseWorkflowSchemaFieldsOrJsonSchema(parsedJson);
  if (!schema) {
    return {
      ok: false,
      error:
        "Schema must be either a field array or a JSON Schema object with top-level properties.",
    };
  }

  if (schema.length === 0) {
    return { ok: true, configured: false, schema: [] };
  }

  return { ok: true, configured: true, schema };
}

/**
 * The one type every schema this module builds is handed back as.
 *
 * `Codec` rather than `ConstraintDecoder`: a field is annotated after it is
 * built, and the annotation methods belong to the full schema protocol. Fixing
 * both service parameters to `never` is what keeps the finished validator
 * decodable without a runtime.
 */
type FieldSchema = Schema.Codec<unknown, unknown>;

/**
 * What the editor's schema builder calls a timestamp: any text a `Date` can be
 * built from, surrounding whitespace ignored.
 *
 * This is deliberately looser than `types/timestamp.ts`, which owns the
 * timestamps this project writes and reads back. A step's output arrives from
 * somewhere else -- an HTTP response, a database row -- and the schema builder
 * only claims the field holds a date, not that it holds one in this project's
 * wire form.
 */
function buildTimestampSchema(): FieldSchema {
  return Schema.String.check(
    Schema.makeFilter((value: string) =>
      Number.isNaN(Date.parse(value.trim()))
        ? "Expected timestamp string"
        : undefined
    )
  );
}

/**
 * What a message calls the type a field was declared as.
 *
 * An absent key carries no schema for the formatter to read a type off, so the
 * name is written into the key annotation while the field is being built and
 * read back out when the key turns out to be missing.
 */
function fieldTypeName(field: WorkflowSchemaField): string {
  if (field.type === "array") {
    return "an array";
  }

  if (field.type === "object") {
    return "an object";
  }

  if (field.type === "timestamp") {
    return "timestamp string";
  }

  return field.type;
}

function buildFieldSchema(field: WorkflowSchemaField): FieldSchema {
  const missingKey = {
    messageMissingKey: `Expected ${fieldTypeName(field)}, got no value`,
  };

  if (field.type === "string") {
    return Schema.String.annotateKey(missingKey);
  }

  if (field.type === "number") {
    return Schema.Number.annotateKey(missingKey);
  }

  if (field.type === "boolean") {
    return Schema.Boolean.annotateKey(missingKey);
  }

  if (field.type === "timestamp") {
    return buildTimestampSchema().annotateKey(missingKey);
  }

  if (field.type === "object") {
    return buildWorkflowSchemaObject(field.fields ?? []).annotateKey(
      missingKey
    );
  }

  const itemType = field.itemType ?? "string";
  if (itemType === "string") {
    return Schema.Array(Schema.String).annotateKey(missingKey);
  }

  if (itemType === "number") {
    return Schema.Array(Schema.Number).annotateKey(missingKey);
  }

  if (itemType === "boolean") {
    return Schema.Array(Schema.Boolean).annotateKey(missingKey);
  }

  if (itemType === "timestamp") {
    return Schema.Array(buildTimestampSchema()).annotateKey(missingKey);
  }

  return Schema.Array(
    buildWorkflowSchemaObject(field.fields ?? [])
  ).annotateKey(missingKey);
}

/**
 * A struct admits keys it does not name: excess properties are dropped rather
 * than rejected unless the decode asks otherwise, and this one never does. That
 * is the behaviour a step output wants, because the schema names the fields a
 * workflow may read downstream, not every field the step happens to return.
 *
 * An object with no named fields is a record rather than a struct, because
 * Effect answers `Schema.Struct({})` with a not-nullish refinement: it would
 * admit a number, a string, and an array alike, and the schema builder's empty
 * object means "some object" and nothing looser.
 */
function buildWorkflowSchemaObject(schema: WorkflowSchemaField[]): FieldSchema {
  const fields: Record<string, FieldSchema> = {};

  for (const field of schema) {
    const fieldName = field.name.trim();
    if (!fieldName) {
      continue;
    }
    fields[fieldName] = buildFieldSchema(field);
  }

  if (Object.keys(fields).length === 0) {
    return Schema.Record(Schema.String, Schema.Unknown);
  }

  return Schema.Struct(fields);
}

export function validateWorkflowOutputAgainstSchema(input: {
  schemaValue: unknown;
  output: unknown;
  contextLabel: string;
}): { ok: true } | { ok: false; error: string } {
  const parsedSchema = parseWorkflowSchemaString(input.schemaValue);
  if (!parsedSchema.ok) {
    return {
      ok: false,
      error: `${input.contextLabel} schema is invalid: ${parsedSchema.error}`,
    };
  }

  if (!parsedSchema.configured) {
    return { ok: true };
  }

  const validator = buildWorkflowSchemaObject(parsedSchema.schema);
  // `errors: "all"` because the summary counts the issues it did not show;
  // stopping at the first one would make that count always zero.
  const validationResult = Schema.decodeUnknownResult(validator, {
    errors: "all",
  })(input.output);
  if (Result.isSuccess(validationResult)) {
    return { ok: true };
  }

  return {
    ok: false,
    error: `${input.contextLabel} output does not match schema: ${formatSchemaFailure(validationResult.failure.issue)}`,
  };
}
