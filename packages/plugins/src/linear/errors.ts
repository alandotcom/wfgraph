import {
  LinearError,
  type LinearErrorRaw,
  parseLinearError,
} from "@linear/sdk";
import { getErrorMessage } from "@wfgraph/core/plugin";
import { Option, Schema } from "effect";

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
 * makes Linear's own parsing throw. Each object uses `Schema.StructWithRest` so
 * the unnamed fields survive at every level; a closed struct would strip them.
 *
 * Fields are described as the API sends them. Linear's LinearErrorRaw types both
 * the per-error `message` and `extensions.type` as its LinearErrorType enum, while
 * the wire carries readable text ("Authentication required") and a lowercase
 * phrase ("authentication error") that Linear maps back to the enum itself.
 */
const unknownFields = [Schema.Record(Schema.String, Schema.Unknown)] as const;

const linearErrorExtensionSchema = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.optionalKey(Schema.String),
    userError: Schema.optionalKey(Schema.Boolean),
    userPresentableMessage: Schema.optionalKey(Schema.String),
  }),
  unknownFields
);

const linearGraphqlErrorSchema = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    path: Schema.optionalKey(Schema.Array(Schema.String)),
    extensions: Schema.optionalKey(linearErrorExtensionSchema),
  }),
  unknownFields
);

const linearRequestSchema = Schema.StructWithRest(
  Schema.Struct({
    query: Schema.optionalKey(Schema.String),
    variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  unknownFields
);

const linearResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    status: Schema.optionalKey(Schema.Finite),
    error: Schema.optionalKey(Schema.String),
    errors: Schema.optionalKey(Schema.Array(linearGraphqlErrorSchema)),
  }),
  unknownFields
);

const linearErrorRawSchema = Schema.StructWithRest(
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
    request: Schema.optionalKey(linearRequestSchema),
    response: Schema.optionalKey(linearResponseSchema),
  }),
  unknownFields
);

const decodeLinearErrorRaw = Schema.decodeUnknownOption(linearErrorRawSchema);

function readLinearErrorRaw(input: unknown) {
  if (typeof input !== "object" || input === null) {
    return decodeLinearErrorRaw(input);
  }

  const ownProperties = Object.fromEntries(
    Object.getOwnPropertyNames(input).map((key) => [
      key,
      Reflect.get(input, key),
    ])
  );
  return decodeLinearErrorRaw(ownProperties);
}

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
    // carries to Linear's enum, and bridges Effect's readonly arrays to the mutable
    // arrays in Linear's input type. Linear only maps over those arrays, and maps the
    // wire text back to its enum itself.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return parseLinearError(raw as unknown as LinearErrorRaw);
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
