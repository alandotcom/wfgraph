/**
 * Resend's email API over fetch.
 *
 * One call is made against Resend in this plugin, `POST /emails`, plus a
 * credential check. The `resend` SDK was a thin wrapper over those, so the calls
 * are written out here instead. Everything after the request is described in
 * `vendor-http.ts`, so what is left here is the bearer token, the two endpoints,
 * and how Resend's error body reads.
 *
 * The request body uses Resend's own field names, which are snake_case on the
 * wire (`reply_to`, `scheduled_at`, `topic_id`) where the SDK spelled them
 * camelCase. Getting that backwards drops those fields silently, so the mapping
 * is asserted in resend/steps/send-email.test.ts.
 */

import type { Effect } from "effect";
import { Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { JsonObject, JsonValue } from "@rova/shared/types/json";
import { callVendor, parsePayload, type VendorError } from "#src/vendor-http";

const RESEND_API_BASE = "https://api.resend.com";

/** Resend's error body. `name` is the machine-readable slug. */
const resendErrorSchema = Schema.Struct({
  statusCode: Schema.optionalKey(Schema.Finite),
  name: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

const sentEmailSchema = Schema.Struct({ id: Schema.String });

/**
 * Resend's error body, for a caller that reports more than the message.
 *
 * The connection test is that caller: a send-only key answers
 * `restricted_api_key` on the domains endpoint, which confirms the key works,
 * and only the slug says so.
 */
export function readResendError(payload: JsonValue | undefined) {
  return parsePayload(payload, resendErrorSchema);
}

/**
 * What Resend said, in one sentence a person reads.
 *
 * A refusal carries Resend's own message when its error body is the documented
 * shape and the bare status when it is not. A 2xx whose body is not the
 * documented resource says so, because reporting success there would tell the
 * run an email went out and leave nothing to look it up by.
 */
export function describeResendFailure(error: VendorError): string {
  if (error._tag === "VendorUnreachable") {
    return error.message;
  }

  if (error._tag === "VendorUnreadable") {
    return `Resend answered ${error.status} with an unrecognized body`;
  }

  return readResendError(error.payload)?.message ?? `HTTP ${error.status}`;
}

function requestResend<S extends Schema.ConstraintDecoder<unknown>>(
  apiKey: string,
  path: string,
  schema: S,
  init: {
    method: "GET" | "POST";
    jsonBody?: JsonObject;
    /**
     * Resend replays the original response for a repeated key rather than
     * sending a second email, which is what makes a retried step safe.
     */
    idempotencyKey?: string;
  }
): Effect.Effect<S["Type"], VendorError, HttpClient.HttpClient> {
  return callVendor({
    vendor: "Resend",
    url: `${RESEND_API_BASE}${path}`,
    method: init.method,
    headers: { authorization: `Bearer ${apiKey}` },
    body:
      init.jsonBody === undefined
        ? undefined
        : { kind: "json", value: init.jsonBody },
    idempotencyKey: init.idempotencyKey,
    schema,
  });
}

export function sendResendEmail(
  apiKey: string,
  payload: JsonObject,
  idempotencyKey?: string
): Effect.Effect<{ id: string }, VendorError, HttpClient.HttpClient> {
  return requestResend(apiKey, "/emails", sentEmailSchema, {
    method: "POST",
    jsonBody: payload,
    idempotencyKey,
  });
}

/**
 * Listing domains is a read-only call any valid key can make, which makes it the
 * check that says whether a key works without sending anything.
 */
export function listResendDomains(
  apiKey: string
): Effect.Effect<unknown, VendorError, HttpClient.HttpClient> {
  return requestResend(apiKey, "/domains", Schema.Unknown, { method: "GET" });
}
