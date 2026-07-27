import { z } from "zod";
import {
  parseWorkflowSchemaFieldsOrJsonSchema,
  type WorkflowSchemaField,
} from "@/workflow/schema-codec";

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

function buildTimestampSchema(): z.ZodType {
  return z
    .string()
    .trim()
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "Expected timestamp string",
    });
}

function buildFieldSchema(field: WorkflowSchemaField): z.ZodType {
  if (field.type === "string") {
    return z.string();
  }

  if (field.type === "number") {
    return z.number();
  }

  if (field.type === "boolean") {
    return z.boolean();
  }

  if (field.type === "timestamp") {
    return buildTimestampSchema();
  }

  if (field.type === "object") {
    return buildWorkflowSchemaObject(field.fields ?? []);
  }

  const itemType = field.itemType ?? "string";
  if (itemType === "string") {
    return z.array(z.string());
  }

  if (itemType === "number") {
    return z.array(z.number());
  }

  if (itemType === "boolean") {
    return z.array(z.boolean());
  }

  if (itemType === "timestamp") {
    return z.array(buildTimestampSchema());
  }

  return z.array(buildWorkflowSchemaObject(field.fields ?? []));
}

function buildWorkflowSchemaObject(schema: WorkflowSchemaField[]) {
  const shape: Record<string, z.ZodType> = {};

  for (const field of schema) {
    const fieldName = field.name.trim();
    if (!fieldName) {
      continue;
    }
    shape[fieldName] = buildFieldSchema(field);
  }

  return z.object(shape).loose();
}

function formatIssuePath(issue: z.core.$ZodIssue): string {
  if (issue.path.length === 0) {
    return "<root>";
  }

  let path = "";
  for (const segment of issue.path) {
    if (typeof segment === "number") {
      path += `[${segment}]`;
      continue;
    }

    if (!path) {
      path = String(segment);
      continue;
    }

    path += `.${String(segment)}`;
  }

  return path || "<root>";
}

function formatZodIssueSummary(issues: z.core.$ZodIssue[]): string {
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
  const validationResult = validator.safeParse(input.output);
  if (validationResult.success) {
    return { ok: true };
  }

  return {
    ok: false,
    error: `${input.contextLabel} output does not match schema: ${formatZodIssueSummary(validationResult.error.issues)}`,
  };
}
