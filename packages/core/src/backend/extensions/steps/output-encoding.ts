/**
 * The encode every action's answer passes through on its way out, worded once.
 *
 * A result is memoized by the durable runtime and stored as a node output, so it
 * has to be JSON, and the output schema is the only thing that knows what this
 * action returns. Encoding through the canonical JSON codec is what turns a
 * `Date` or an `Option` into JSON rather than leaving it to survive by accident
 * through `Date.prototype.toJSON` and come back a string on the replay.
 *
 * `defineStep` and `defineAction` both encode here, so the two halves of the
 * authoring vocabulary answer one mistake with one sentence. `subject` is the
 * phrase that sentence names the offender by -- `Step "twilio/send-sms"` or
 * `Action "appointments/cancel"` -- the same way `requireOutputFieldsFromSchema`
 * takes a phrase rather than an id.
 */

import { Result, Schema } from "effect";
import { formatSchemaFailure } from "@rova/shared/types/schema-message";

/**
 * An encoder for one action's output schema, answering a ready-made sentence
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
