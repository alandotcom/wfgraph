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

import { Schema } from "effect";
import type { JsonObject } from "@rova/shared/types/json";
import {
  callVendor,
  parsePayload,
  runVendorCall,
  type VendorError,
} from "#src/vendor-http";

const RESEND_API_BASE = "https://api.resend.com";

/** Resend's error body. `name` is the machine-readable slug. */
const resendErrorSchema = Schema.Struct({
  statusCode: Schema.optionalKey(Schema.Finite),
  name: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});

const sentEmailSchema = Schema.Struct({ id: Schema.String });

export type ResendFailure =
  | { kind: "unreachable"; message: string }
  | {
      kind: "rejected";
      status: number;
      message: string;
      /** Resend's own slug, such as "restricted_api_key". */
      name?: string;
    }
  /** A 2xx whose body is not what Resend documents. */
  | { kind: "unreadable"; status: number };

export type ResendResult<TData> =
  | { ok: true; data: TData }
  | { ok: false; failure: ResendFailure };

export function describeResendFailure(failure: ResendFailure): string {
  if (failure.kind === "unreadable") {
    return `Resend answered ${failure.status} with an unrecognized body`;
  }
  return failure.message;
}

/**
 * Resend's three failures in the vocabulary this plugin's steps already read.
 * Stage 6 of ADR-0002 makes a step handler an Effect over `VendorError` and
 * this translation goes away with the `ResendResult` shape it feeds.
 *
 * The status a caller sees is the one in the body when Resend put one there,
 * which is the number its own documentation quotes for a slug.
 */
function toResendFailure(error: VendorError): ResendFailure {
  if (error._tag === "VendorUnreachable") {
    return { kind: "unreachable", message: error.message };
  }

  if (error._tag === "VendorUnreadable") {
    return { kind: "unreadable", status: error.status };
  }

  const body = parsePayload(error.payload, resendErrorSchema);
  return {
    kind: "rejected",
    status: body?.statusCode ?? error.status,
    message: body?.message ?? `HTTP ${error.status}`,
    name: body?.name,
  };
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
): Promise<ResendResult<S["Type"]>> {
  return runVendorCall(
    callVendor({
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
    }),
    toResendFailure
  );
}

export function sendResendEmail(
  apiKey: string,
  payload: JsonObject,
  idempotencyKey?: string
): Promise<ResendResult<{ id: string }>> {
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
): Promise<ResendResult<unknown>> {
  return requestResend(apiKey, "/domains", Schema.Unknown, { method: "GET" });
}
