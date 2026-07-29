/**
 * Slack Web API over fetch.
 *
 * Two calls are made against Slack in this plugin: `chat.postMessage` to send a
 * message and `auth.test` to check a bot token. @slack/web-api brought a
 * dependency tree along for those two, so they are written out here.
 *
 * Slack's HTTP layer is unusual in one way worth knowing: a rejected request
 * still answers 200, with `ok: false` and an error slug in the body. That is
 * what `refusedInBody` below tells `vendor-http.ts` to look for, so the slug
 * arrives as the same refusal a 4xx would be. A status Slack does not use for
 * its own answers stays the plain HTTP failure it always was, which is the same
 * distinction @slack/web-api drew between its PlatformError and HTTPError codes.
 *
 * The retry the SDK did and this did not now lives in `vendor-http.ts`, honouring
 * `Retry-After` on a 429. It reaches a Slack call only when the caller says the
 * call is safe to repeat, because Slack spells even its reads as POSTs and this
 * module cannot tell one from the other by the method alone.
 */

import type { Effect } from "effect";
import { Schema } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { JsonObject, JsonValue } from "@rova/shared/types/json";
import { callVendor, parsePayload, type VendorError } from "#src/vendor-http";

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Slack answers every call with this envelope, on success and failure alike.
 * The fields a caller actually wants sit beside these two, which is why the
 * caller's own schema reads the same payload again below.
 */
const slackEnvelopeSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});

/**
 * Slack's own error slug out of a refusal, or undefined when the refusal did
 * not come from Slack.
 *
 * A refusal that does not read as a Slack envelope, or reads as one that says
 * `ok: true`, came from something standing in front of the API, so its status
 * is all there is to report. A caller that distinguishes the two -- the
 * connection test does, because it words them differently -- asks here.
 */
export function readSlackError(
  payload: JsonValue | undefined
): string | undefined {
  const envelope = parsePayload(payload, slackEnvelopeSchema);
  if (envelope === undefined || envelope.ok) {
    return undefined;
  }

  return envelope.error ?? "unknown_error";
}

/** What Slack said, in one sentence a person reads. */
export function describeSlackFailure(error: VendorError): string {
  if (error._tag === "VendorUnreachable") {
    return error.message;
  }

  if (error._tag === "VendorUnreadable") {
    return `HTTP ${error.status}`;
  }

  return readSlackError(error.payload) ?? `HTTP ${error.status}`;
}

/**
 * `options` carries the arguments Slack's method takes and whether repeating the
 * call is safe, in one bag so that a caller wanting the second does not have to
 * name the first.
 */
export function callSlack<S extends Schema.ConstraintDecoder<unknown>>(
  token: string,
  method: string,
  schema: S,
  options: { body?: JsonObject; safeToRepeat?: true } = {}
): Effect.Effect<S["Type"], VendorError, HttpClient.HttpClient> {
  return callVendor({
    vendor: "Slack",
    url: `${SLACK_API_BASE}/${method}`,
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      // Slack's reference asks for application/json; the charset suffix is what
      // @slack/web-api sent and Slack accepts either.
      "content-type": "application/json; charset=utf-8",
    },
    // A method that takes no arguments still wants a body, so send an empty one.
    body: { kind: "json", value: options.body ?? {} },
    schema,
    // Anything short of a positively ok envelope is Slack saying no, which
    // covers both its own slug and a 200 carrying something else entirely.
    refusedInBody: (payload) =>
      parsePayload(payload, slackEnvelopeSchema)?.ok !== true,
    safeToRepeat: options.safeToRepeat,
  });
}
