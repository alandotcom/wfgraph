/**
 * Slack Web API over fetch.
 *
 * Two calls are made against Slack in this plugin: `chat.postMessage` to send a
 * message and `auth.test` to check a bot token. @slack/web-api brought a
 * dependency tree along for those two, so they are written out here.
 *
 * Slack's HTTP layer is unusual in one way worth knowing: a rejected request
 * still answers 200, with `ok: false` and an error slug in the body. Both halves
 * are checked below, which is the same distinction @slack/web-api drew between
 * its PlatformError and HTTPError codes.
 *
 * One thing the SDK did that this does not: retry. It retried a failed call up
 * to ten times over about thirty minutes and backed off on a 429 by itself.
 * Here the engine's function-level retry counter is the whole policy, which is
 * a coarser answer to a rate limit than honouring `Retry-After` would be.
 */

import { z } from "zod";
import type { JsonObject } from "@rova/shared/types/json";
import { parsePayload, requestVendor } from "@/vendor-http";

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Slack answers every call with this envelope, on success and failure alike.
 * Loose, because the fields a caller actually wants sit beside these two.
 */
const slackEnvelopeSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
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

export async function callSlack<TSchema extends z.ZodType>(
  token: string,
  method: string,
  schema: TSchema,
  body?: JsonObject
): Promise<SlackResult<z.infer<TSchema>>> {
  const response = await requestVendor({
    url: `${SLACK_API_BASE}/${method}`,
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      // Slack's reference asks for application/json; the charset suffix is what
      // @slack/web-api sent and Slack accepts either.
      "content-type": "application/json; charset=utf-8",
    },
    // A method that takes no arguments still wants a body, so send an empty one.
    body: JSON.stringify(body ?? {}),
  });

  if (response.kind === "unreachable") {
    return { ok: false, failure: response };
  }

  const envelope = parsePayload(response.payload, slackEnvelopeSchema);

  if (!envelope) {
    return { ok: false, failure: { kind: "http", status: response.status } };
  }

  if (!envelope.ok) {
    return {
      ok: false,
      failure: {
        kind: "rejected",
        status: response.status,
        slackError: envelope.error ?? "unknown_error",
      },
    };
  }

  const data = parsePayload(response.payload, schema);
  if (data === undefined) {
    return { ok: false, failure: { kind: "http", status: response.status } };
  }

  return { ok: true, data };
}
