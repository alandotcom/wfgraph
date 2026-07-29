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
 * its own answers stays the `http` failure it always was, which is the same
 * distinction @slack/web-api drew between its PlatformError and HTTPError codes.
 *
 * The retry the SDK did and this did not now lives in `vendor-http.ts`, honouring
 * `Retry-After` on a 429. It reaches a Slack call only when the caller says the
 * call is safe to repeat, because Slack spells even its reads as POSTs and this
 * module cannot tell one from the other by the method alone.
 */

import { Schema } from "effect";
import type { JsonObject } from "@rova/shared/types/json";
import {
  callVendor,
  parsePayload,
  runVendorCall,
  type VendorError,
} from "#src/vendor-http";

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

export type SlackFailure =
  | { kind: "unreachable"; message: string }
  /** Slack answered, and said no. `slackError` is its own slug, "invalid_auth". */
  | { kind: "rejected"; status: number; slackError: string }
  /** Something answered with a status Slack does not use for its own answers. */
  | { kind: "http"; status: number };

export type SlackResult<TData> =
  | { ok: true; data: TData }
  | { ok: false; failure: SlackFailure };

export function describeSlackFailure(failure: SlackFailure): string {
  if (failure.kind === "unreachable") {
    return failure.message;
  }
  if (failure.kind === "rejected") {
    return failure.slackError;
  }
  return `HTTP ${failure.status}`;
}

/**
 * Slack's three failures in the vocabulary this plugin's steps already read.
 * Stage 6 of ADR-0002 makes a step handler an Effect over `VendorError` and
 * this translation goes away with the `SlackResult` shape it feeds.
 *
 * A refusal that does not read as a Slack envelope came from something other
 * than Slack, so its status is all there is to report.
 */
function toSlackFailure(error: VendorError): SlackFailure {
  if (error._tag === "VendorUnreachable") {
    return { kind: "unreachable", message: error.message };
  }

  if (error._tag === "VendorUnreadable") {
    return { kind: "http", status: error.status };
  }

  const envelope = parsePayload(error.payload, slackEnvelopeSchema);
  if (envelope === undefined || envelope.ok) {
    return { kind: "http", status: error.status };
  }

  return {
    kind: "rejected",
    status: error.status,
    slackError: envelope.error ?? "unknown_error",
  };
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
): Promise<SlackResult<S["Type"]>> {
  return runVendorCall(
    callVendor({
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
    }),
    toSlackFailure
  );
}
