/**
 * The encode every action's answer passes through on its way out, worded once.
 *
 * A result is memoized by the durable runtime and stored as a node output, so it
 * has to be JSON, and the output schema is the only thing that knows what this
 * action returns. An Effect schema encodes through its canonical JSON codec; a
 * foreign Standard Schema library validates through `~standard.validate` and
 * keeps the value that call returns. Both paths fail the node once when the
 * answer does not fit.
 *
 * `defineStep` and `defineAction` both encode here, so the two halves of the
 * authoring vocabulary answer one mistake with one sentence. `subject` is the
 * phrase that sentence names the offender by -- `Step "twilio/send-sms"` or
 * `Action "appointments/cancel"` -- the same way `requireOutputFieldsFromSchema`
 * takes a phrase rather than an id.
 */

import { Result, Schema } from "effect";
import { validateStandardSchema } from "#src/backend/extensions/schema-io";
import type { StandardSchema } from "@wfgraph/shared/types/schema";
import { formatSchemaFailure } from "@wfgraph/shared/types/schema-message";

/**
 * An encoder for one Effect output schema, answering a ready-made sentence
 * where the value does not fit.
 *
 * The codec is built here rather than per invocation, because `toCodecJson`
 * walks the AST and builds a new schema.
 */
export function encodeThroughOutputSchema(
  subject: string,
  schema: Schema.ConstraintCodec<unknown, unknown>
): (value: unknown) => Result.Result<unknown, string> {
  // `errors: "all"` is what `formatSchemaFailure` is written against: it counts
  // the issues it does not spell out, and stopping at the first would make that
  // count always zero.
  const encode = Schema.encodeUnknownResult(Schema.toCodecJson(schema), {
    errors: "all",
  });

  return (value) =>
    Result.mapError(
      encode(value),
      (error) =>
        `${subject} returned a value its output schema cannot encode: ${formatSchemaFailure(error.issue)}`
    );
}

/**
 * A validator for one foreign Standard Schema output, answering the same kind
 * of sentence the Effect arm does.
 *
 * Standard Schema publishes no encode direction. What it does publish is
 * `~standard.validate`, and that call's returned `value` is what the node keeps:
 * a library that strips undeclared keys (Zod's default object) trims here the
 * way Effect's encode does, and a library that keeps them (`z.looseObject`)
 * keeps them because the author said so in the schema.
 */
export function validateThroughOutputSchema<TOutput>(
  subject: string,
  schema: StandardSchema<TOutput>
): (value: unknown) => Result.Result<TOutput, string> {
  return (value) =>
    Result.mapError(
      validateStandardSchema(
        schema,
        value,
        "An output schema must validate synchronously. Async Standard Schema validators are not supported."
      ),
      (failure) =>
        `${subject} returned a value its output schema does not accept: ${failure}`
    );
}
