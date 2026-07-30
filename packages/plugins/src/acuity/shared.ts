/**
 * Turning what a config field holds into what Acuity's API takes.
 *
 * Acuity wants whole numbers, real booleans and a list of form answers where
 * the editor gives a step text, so each of these reads one field and says, in
 * the words the run log shows, what is wrong with it. They answer an `Effect`,
 * so a step names the field and moves on -- `yield*` is the whole of the
 * handling, where a result object needed a check and an early return after
 * every single one.
 *
 * The messages are the reason the reading stays here rather than moving into
 * the input schemas: a decode that fails inside `defineStep` reports itself as
 * an invalid configuration for the action, and what an author needs to read is
 * which box holds what. The two schema declarations at the top are the other
 * half of the same boundary -- what an input schema says a config field may
 * hold, before one of these parsers reads it.
 */

import { StepFailure } from "@rova/core/plugin";
import { Effect, Result, Schema } from "effect";

/** Every config field arrives as text, so this is what most of them look like. */
export const optionalText = Schema.optionalKey(Schema.String);

/**
 * A number a config field carries.
 *
 * A `number` config field may be stored as a number and a template resolves to
 * text, so both arrive and the step parses whichever it got.
 */
export const optionalNumeric = Schema.optionalKey(
  Schema.Union([Schema.String, Schema.Finite])
);

/** A config value as text, or nothing when the field was left empty. */
function normalizeRawValue(
  value: string | number | undefined
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number") {
    return String(value);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function positiveIntegerOr(
  normalized: string,
  fieldLabel: string
): Effect.Effect<number, StepFailure> {
  const parsed = Number(normalized);

  return Number.isInteger(parsed) && parsed > 0
    ? Effect.succeed(parsed)
    : Effect.fail(
        new StepFailure({
          message: `${fieldLabel} must be a positive integer.`,
        })
      );
}

export function requiredInteger(
  value: string | number | undefined,
  fieldLabel: string
): Effect.Effect<number, StepFailure> {
  const normalized = normalizeRawValue(value);

  return normalized
    ? positiveIntegerOr(normalized, fieldLabel)
    : Effect.fail(new StepFailure({ message: `${fieldLabel} is required.` }));
}

export function optionalInteger(
  value: string | number | undefined,
  fieldLabel: string
): Effect.Effect<number | undefined, StepFailure> {
  const normalized = normalizeRawValue(value);

  return normalized
    ? positiveIntegerOr(normalized, fieldLabel)
    : Effect.succeed(undefined);
}

/**
 * A select whose options are "", "true" and "false", read as the boolean Acuity
 * takes. An empty choice is the absent one, which is how a step says "leave
 * Acuity's own default alone".
 */
export function optionalBoolean(
  value: string | undefined,
  fieldLabel: string
): Effect.Effect<boolean | undefined, StepFailure> {
  if (value === undefined || value === "") {
    return Effect.succeed(undefined);
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "true") {
    return Effect.succeed(true);
  }

  if (normalized === "false") {
    return Effect.succeed(false);
  }

  return Effect.fail(
    new StepFailure({
      message: `${fieldLabel} must be true, false, or empty.`,
    })
  );
}

export function optionalIntegerList(
  value: string | undefined,
  fieldLabel: string
): Effect.Effect<number[] | undefined, StepFailure> {
  const normalized = normalizeRawValue(value);

  if (!normalized) {
    return Effect.succeed(undefined);
  }

  const entries = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    return Effect.succeed(undefined);
  }

  const parsed = entries.map((entry) => Number(entry));
  const invalid = parsed.some(
    (entry) => !Number.isInteger(entry) || entry <= 0
  );

  return invalid
    ? Effect.fail(
        new StepFailure({
          message: `${fieldLabel} must contain only positive integers (comma separated).`,
        })
      )
    : Effect.succeed(parsed);
}

/**
 * Acuity takes the answers to a booking form's custom questions as fieldID/value
 * pairs. Workflow authors type those pairs as a JSON string into the node config,
 * so this schema is the boundary between that text and the Acuity client.
 *
 * `errors: "all"` because what the decode says about the text is what the author
 * reads back in the step's failure: naming one mistake at a time would send them
 * round the loop once per mistake.
 */
const acuityCustomFieldsSchema = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      fieldID: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      value: Schema.Union([
        Schema.String,
        Schema.mutable(Schema.Array(Schema.String)),
      ]),
    })
  )
);

const decodeCustomFields = Schema.decodeUnknownResult(
  acuityCustomFieldsSchema,
  {
    errors: "all",
  }
);

type AcuityCustomFields = typeof acuityCustomFieldsSchema.Type;

export function optionalCustomFields(
  value: string | undefined
): Effect.Effect<AcuityCustomFields | undefined, StepFailure> {
  const normalized = normalizeRawValue(value);

  if (!normalized) {
    return Effect.succeed(undefined);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(normalized);
  } catch {
    return Effect.fail(
      new StepFailure({
        message:
          'Custom Fields JSON must be valid JSON in the format [{"fieldID":1234,"value":"text"}].',
      })
    );
  }

  const result = decodeCustomFields(parsed);

  return Result.isFailure(result)
    ? Effect.fail(
        new StepFailure({
          message: `Custom Fields JSON must be an array of objects with numeric fieldID and value (string or string[]). ${result.failure.message}`,
        })
      )
    : Effect.succeed(result.success);
}
