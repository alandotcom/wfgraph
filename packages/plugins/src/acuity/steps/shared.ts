import { z } from "zod";

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function normalizeRawValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return;
}

export function parseRequiredInteger(
  value: unknown,
  fieldLabel: string
): ParseResult<number> {
  const normalized = normalizeRawValue(value);

  if (!normalized) {
    return {
      ok: false,
      error: `${fieldLabel} is required.`,
    };
  }

  const parsed = Number(normalized);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      error: `${fieldLabel} must be a positive integer.`,
    };
  }

  return { ok: true, value: parsed };
}

export function parseOptionalInteger(
  value: unknown,
  fieldLabel: string
): ParseResult<number | undefined> {
  const normalized = normalizeRawValue(value);

  if (!normalized) {
    return { ok: true, value: undefined };
  }

  const parsed = Number(normalized);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      error: `${fieldLabel} must be a positive integer.`,
    };
  }

  return { ok: true, value: parsed };
}

export function parseOptionalBoolean(
  value: unknown,
  fieldLabel: string
): ParseResult<boolean | undefined> {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: undefined };
  }

  if (typeof value === "boolean") {
    return { ok: true, value };
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true") {
      return { ok: true, value: true };
    }

    if (normalized === "false") {
      return { ok: true, value: false };
    }
  }

  return {
    ok: false,
    error: `${fieldLabel} must be true, false, or empty.`,
  };
}

export function parseCommaSeparatedIntegerList(
  value: unknown,
  fieldLabel: string
): ParseResult<number[] | undefined> {
  const normalized = normalizeRawValue(value);

  if (!normalized) {
    return { ok: true, value: undefined };
  }

  const entries = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    return { ok: true, value: undefined };
  }

  const parsed = entries.map((entry) => Number(entry));
  const invalid = parsed.some(
    (entry) => !Number.isInteger(entry) || entry <= 0
  );

  if (invalid) {
    return {
      ok: false,
      error: `${fieldLabel} must contain only positive integers (comma separated).`,
    };
  }

  return { ok: true, value: parsed };
}

/**
 * Acuity takes the answers to a booking form's custom questions as fieldID/value
 * pairs. Workflow authors type those pairs as a JSON string into the node config,
 * so this schema is the boundary between that text and the Acuity client.
 */
const acuityCustomFieldsSchema = z.array(
  z.object({
    fieldID: z.number().int().positive(),
    value: z.union([z.string(), z.array(z.string())]),
  })
);

type AcuityCustomFields = z.infer<typeof acuityCustomFieldsSchema>;

export function parseCustomFieldsJson(
  value: unknown
): ParseResult<AcuityCustomFields | undefined> {
  const normalized = normalizeRawValue(value);

  if (!normalized) {
    return { ok: true, value: undefined };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized);
  } catch {
    return {
      ok: false,
      error:
        'Custom Fields JSON must be valid JSON in the format [{"fieldID":1234,"value":"text"}].',
    };
  }

  const result = acuityCustomFieldsSchema.safeParse(parsed);

  if (!result.success) {
    return {
      ok: false,
      error: `Custom Fields JSON must be an array of objects with numeric fieldID and value (string or string[]). ${z.prettifyError(result.error)}`,
    };
  }

  return { ok: true, value: result.data };
}
