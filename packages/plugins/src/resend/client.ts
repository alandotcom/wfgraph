/**
 * Resend's email API over fetch.
 *
 * One call is made against Resend in this plugin, `POST /emails`, plus a
 * credential check. The `resend` SDK was a thin wrapper over those, so the calls
 * are written out here instead.
 *
 * The request body uses Resend's own field names, which are snake_case on the
 * wire (`reply_to`, `scheduled_at`, `topic_id`) where the SDK spelled them
 * camelCase. Getting that backwards drops those fields silently, so the mapping
 * is asserted in resend/steps/send-email.test.ts.
 */

import { Schema } from "effect";
import type { JsonObject } from "@rova/shared/types/json";
import { parsePayload, requestVendor } from "#src/vendor-http";

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

async function requestResend<S extends Schema.ConstraintDecoder<unknown>>(
  apiKey: string,
  path: string,
  schema: S,
  init: {
    method: string;
    jsonBody?: JsonObject;
    /**
     * Resend replays the original response for a repeated key rather than
     * sending a second email, which is what makes a retried step safe.
     */
    idempotencyKey?: string;
  }
): Promise<ResendResult<S["Type"]>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
  };
  if (init.jsonBody !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (init.idempotencyKey) {
    headers["idempotency-key"] = init.idempotencyKey;
  }

  const response = await requestVendor({
    url: `${RESEND_API_BASE}${path}`,
    method: init.method,
    headers,
    body:
      init.jsonBody === undefined ? undefined : JSON.stringify(init.jsonBody),
  });

  if (response.kind === "unreachable") {
    return { ok: false, failure: response };
  }

  if (!response.ok) {
    const error = parsePayload(response.payload, resendErrorSchema);
    return {
      ok: false,
      failure: {
        kind: "rejected",
        status: error?.statusCode ?? response.status,
        message: error?.message ?? `HTTP ${response.status}`,
        name: error?.name,
      },
    };
  }

  const data = parsePayload(response.payload, schema);
  if (data === undefined) {
    return {
      ok: false,
      failure: { kind: "unreadable", status: response.status },
    };
  }

  return { ok: true, data };
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
