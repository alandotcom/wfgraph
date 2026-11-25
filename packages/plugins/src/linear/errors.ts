/**
 * Linear's GraphQL error envelope, and what a failed call to Linear means.
 *
 * Linear answers a refused operation with a GraphQL `errors` array. The status
 * varies by failure: a query Linear cannot parse is a 400, a missing or invalid
 * API key is a 400 or 401, a rate limit is a 429, and an input Linear rejects
 * while running the operation can arrive as a 200. `client.ts` treats a body
 * carrying the array as a refusal at any status, so every one of these reaches
 * this module as an `ExternalRejected`.
 */

import {
  type ExternalError,
  type JsonValue,
  parsePayload,
} from "@wfgraph/core/plugin";
import { Schema } from "effect";

/**
 * One GraphQL error as Linear sends it. `message` is the GraphQL standard's
 * required field. Linear adds `extensions` with a lowercase `type` such as
 * "authentication error", an uppercase `code` such as "AUTHENTICATION_ERROR",
 * and a `userPresentableMessage` written for a person to read.
 */
const linearGraphqlErrorSchema = Schema.Struct({
  message: Schema.String,
  extensions: Schema.optionalKey(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      code: Schema.optionalKey(Schema.String),
      userPresentableMessage: Schema.optionalKey(Schema.String),
    })
  ),
});

export type LinearGraphqlError = typeof linearGraphqlErrorSchema.Type;

const linearErrorEnvelopeSchema = Schema.Struct({
  errors: Schema.NonEmptyArray(linearGraphqlErrorSchema),
});

/**
 * The GraphQL errors in a response body, or undefined when the body carries
 * none in Linear's shape. A refusal with no such body came from something in
 * front of the API, and its status is all there is to report.
 */
export function readLinearErrors(
  payload: JsonValue | undefined
): readonly LinearGraphqlError[] | undefined {
  return parsePayload(payload, linearErrorEnvelopeSchema)?.errors;
}

/** Whether a response body is Linear refusing the operation. */
export function carriesLinearErrors(payload: JsonValue | undefined): boolean {
  return readLinearErrors(payload) !== undefined;
}

/**
 * What Linear said, in the one sentence a step's failure carries.
 *
 * The first GraphQL error is the specific one. Its `userPresentableMessage` is
 * the wording Linear writes for a person, and its `message` is the fallback.
 */
export function describeLinearFailure(error: ExternalError): string {
  if (error._tag === "ExternalUnreachable") {
    return error.message;
  }

  if (error._tag === "ExternalUnreadable") {
    return `Linear answered ${error.status} with an unrecognized body`;
  }

  const first = readLinearErrors(error.payload)?.[0];
  return (
    first?.extensions?.userPresentableMessage ??
    first?.message ??
    `HTTP ${error.status}`
  );
}

/**
 * Whether Linear refused the API key itself. Linear marks that refusal with the
 * `authentication error` type and the `AUTHENTICATION_ERROR` code on the
 * error's `extensions`. A bare 401 with no GraphQL errors in its body counts
 * too.
 */
export function isLinearAuthenticationFailure(error: ExternalError): boolean {
  if (error._tag !== "ExternalRejected") {
    return false;
  }

  const errors = readLinearErrors(error.payload);
  if (errors === undefined) {
    return error.status === 401;
  }

  return errors.some(
    ({ extensions }) =>
      extensions?.type === "authentication error" ||
      extensions?.code === "AUTHENTICATION_ERROR"
  );
}
