import { Option, Result, Schema, SchemaAST, SchemaIssue } from "effect";
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

/** The longest run of a rejected value a message may quote, in characters. */
const MAX_QUOTED_LENGTH = 20;

function truncate(text: string): string {
  return text.length <= MAX_QUOTED_LENGTH
    ? text
    : `${text.slice(0, MAX_QUOTED_LENGTH)}...`;
}

/**
 * How a message names the value it rejected.
 *
 * A step output arrives from somewhere outside this project, and the message
 * built from it is persisted as the run's step error and written to the log.
 * One bad HTTP response is enough to carry a body of addresses and tokens into
 * both, so an object or an array is named by its kind alone and a primitive is
 * cut short. What the reader needs is which value was wrong and what was
 * expected of it, and neither of those is the value itself.
 */
function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(truncate(value));
  }

  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return truncate(String(value));
  }

  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "symbol") {
    return truncate(value.toString());
  }

  if (Array.isArray(value)) {
    return "an array";
  }

  if (typeof value === "function") {
    return "a function";
  }

  return "an object";
}

function describeMissingOrValue(actual: Option.Option<unknown>): string {
  return Option.isNone(actual) ? "no value" : describeValue(actual.value);
}

/** What a message calls the type a schema node asked for. */
function expectedTypeName(ast: SchemaAST.AST): string {
  if (SchemaAST.isString(ast)) {
    return "string";
  }

  if (SchemaAST.isNumber(ast)) {
    return "number";
  }

  if (SchemaAST.isBoolean(ast)) {
    return "boolean";
  }

  if (SchemaAST.isArrays(ast)) {
    return "an array";
  }

  if (SchemaAST.isObjects(ast)) {
    return "an object";
  }

  return "a valid value";
}

/**
 * Every terminal issue, rendered without the value that caused it.
 *
 * Effect's own leaf renderer prints the offending value in full, which is what
 * `describeValue` exists to replace. The issue kinds are told apart by class
 * rather than by their `_tag`, which the repo's lint reserves.
 */
const boundedLeafHook: SchemaIssue.LeafHook = (issue) => {
  if (issue instanceof SchemaIssue.InvalidType) {
    return `Expected ${expectedTypeName(issue.ast)}, got ${describeMissingOrValue(issue.actual)}`;
  }

  if (issue instanceof SchemaIssue.MissingKey) {
    return issue.annotations?.messageMissingKey ?? "Missing key";
  }

  if (issue instanceof SchemaIssue.UnexpectedKey) {
    return `Unexpected key holding ${describeValue(issue.actual)}`;
  }

  if (issue instanceof SchemaIssue.OneOf) {
    return `Expected exactly one match, got ${describeValue(issue.actual)}`;
  }

  return (
    issue.annotations?.message ??
    `Invalid value, got ${describeMissingOrValue(issue.actual)}`
  );
};

/**
 * A check that failed without saying why falls back to Effect's own text, which
 * quotes the value, so the fallback is written here instead. A check that
 * reported something other than a plain rejection is passed on, so its own
 * issues keep their paths.
 */
const boundedCheckHook: SchemaIssue.CheckHook = (issue) => {
  const annotated = SchemaIssue.defaultCheckHook(issue);
  if (annotated !== undefined) {
    return annotated;
  }

  return issue.issue instanceof SchemaIssue.InvalidValue
    ? `Invalid value, got ${describeValue(issue.actual)}`
    : undefined;
};

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: boundedLeafHook,
  checkHook: boundedCheckHook,
});
type FormattedIssue = ReturnType<typeof formatIssues>["issues"][number];

function formatIssuePath(issue: FormattedIssue): string {
  let path = "";
  for (const segment of issue.path ?? []) {
    const key = typeof segment === "object" ? segment.key : segment;

    if (typeof key === "number") {
      path += `[${key}]`;
      continue;
    }

    if (!path) {
      path = String(key);
      continue;
    }

    path += `.${String(key)}`;
  }

  return path || "<root>";
}

function formatIssueSummary(issues: readonly FormattedIssue[]): string {
  const displayedIssues = issues.slice(0, 3);
  const summary = displayedIssues
    .map((issue) => `${formatIssuePath(issue)}: ${issue.message}`)
    .join("; ");

  if (issues.length <= displayedIssues.length) {
    return summary;
  }

  return `${summary}; ... (+${issues.length - displayedIssues.length} more)`;
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
  // `errors: "all"` because the summary above counts the issues it did not
  // show; stopping at the first one would make that count always zero.
  const validationResult = Schema.decodeUnknownResult(validator, {
    errors: "all",
  })(input.output);
  if (Result.isSuccess(validationResult)) {
    return { ok: true };
  }

  return {
    ok: false,
    error: `${input.contextLabel} output does not match schema: ${formatIssueSummary(formatIssues(validationResult.failure.issue).issues)}`,
  };
}
