import {
  LinearError,
  type LinearErrorRaw,
  parseLinearError,
} from "@linear/sdk";
import { Option, Schema } from "effect";
import { getErrorMessage } from "@rova/shared/utils";

/**
 * The error payload Linear's `parseLinearError` reads: the GraphQL request that
 * failed, the response that came back with its status and GraphQL errors, and a
 * top-level message. Anything caught while talking to Linear arrives as `unknown`,
 * so this schema is the boundary that decides whether Linear can classify it.
 *
 * Every level stays open, because Linear reads fields this schema does not name
 * (`response.data`, `response.headers`) and the validated value is handed on to
 * Linear whole. The named fields are the ones Linear reads unguarded: a `message`
 * that is not a string, or a `response.errors` that is not a list of objects,
 * makes Linear's own parsing throw. `onExcessProperty: "preserve"` in the decode
 * below is what keeps the unnamed fields, at every level, on the value that comes
 * back; the default strips them.
 *
 * Fields are described as the API sends them. Linear's LinearErrorRaw types both
 * the per-error `message` and `extensions.type` as its LinearErrorType enum, while
 * the wire carries readable text ("Authentication required") and a lowercase
 * phrase ("authentication error") that Linear maps back to the enum itself.
 */
const linearGraphqlErrorSchema = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.Array(Schema.String)),
  extensions: Schema.optionalKey(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      userError: Schema.optionalKey(Schema.Boolean),
      userPresentableMessage: Schema.optionalKey(Schema.String),
    })
  ),
});

const linearErrorRawSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  request: Schema.optionalKey(
    Schema.Struct({
      query: Schema.optionalKey(Schema.String),
      variables: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Unknown)
      ),
    })
  ),
  response: Schema.optionalKey(
    Schema.Struct({
      status: Schema.optionalKey(Schema.Finite),
      error: Schema.optionalKey(Schema.String),
      errors: Schema.optionalKey(Schema.Array(linearGraphqlErrorSchema)),
    })
  ),
});

const readLinearErrorRaw = Schema.decodeUnknownOption(linearErrorRawSchema, {
  onExcessProperty: "preserve",
});

/**
 * Normalizes anything thrown while talking to Linear into a LinearError, which is
 * what the steps read an error type and a message from. The SDK wraps its own
 * failures, so the remaining cases are a raw error payload from a GraphQL client,
 * a plain Error, and a bare string.
 */
export function toLinearError(error: unknown): LinearError {
  if (error instanceof LinearError) {
    return error;
  }

  const raw = Option.getOrUndefined(readLinearErrorRaw(error));

  if (raw) {
    // Linear's own type for this payload disagrees with what its API sends for the
    // GraphQL error fields, so the validated value goes back under Linear's type.
    // The assertion narrows `message` and `extensions.type` from the string the wire
    // carries to Linear's enum, which holds because Linear maps that text back itself.
    // Removing the assertion turns this into a type error, so the narrowing is the
    // point rather than an oversight.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return parseLinearError(raw as LinearErrorRaw);
  }

  if (error instanceof Error) {
    return parseLinearError({ name: error.name, message: error.message });
  }

  if (typeof error === "string") {
    return parseLinearError({ message: error });
  }

  return parseLinearError();
}

/**
 * What Linear said, in the one sentence a step's failure carries.
 *
 * The GraphQL error is the specific one -- "Entity not found: Issue" -- and the
 * wrapper's message is the general one, so the first that says anything wins.
 * A throw Linear cannot classify at all falls through to whatever the thrown
 * value had to say for itself.
 */
export function describeLinearFailure(error: unknown): string {
  const linearError = toLinearError(error);

  return (
    linearError.errors?.[0]?.message ||
    linearError.message ||
    getErrorMessage(error)
  );
}
