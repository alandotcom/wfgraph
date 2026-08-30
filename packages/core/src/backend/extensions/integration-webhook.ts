/**
 * How an integration receives a vendor POST and turns it into an Event send.
 *
 * `verify` runs on the raw body, because Svix and every HMAC scheme are
 * sensitive to a single byte of re-serialization. `receive` then sees the
 * parsed JSON. The route reads the body once and hands both halves what they
 * need; nothing here consumes the Request.
 *
 * Handshake (a Slack `url_verification`) is a `receive` answer that returns a
 * Response and does not send. An ignored payload is `undefined`, which the
 * route answers 200 rather than an error, so a vendor retry storm does not
 * follow a subtype this integration chose not to model.
 */

import type { Effect } from "effect";
import { Schema } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";

/**
 * The vendor's signature did not match the Connection's secret.
 *
 * The HTTP route turns this into a 401. The sentence is for the sender, so it
 * names the rule and quotes nothing of what arrived.
 */
export class SignatureRejected extends Schema.TaggedError<SignatureRejected>()(
  "SignatureRejected",
  {
    error: Schema.String,
  }
) {}

/** An accepted payload, as `inngest.send` takes it. */
export type WebhookAccepted = {
  readonly event: string;
  readonly data: JsonObject;
  /** Inngest idempotency key. Resend sets this from `svix-id`. */
  readonly id?: string;
};

/** A challenge the vendor must hear back, with no Event send. */
export type WebhookHandshake = {
  readonly handshake: Response;
};

export type WebhookReceiveResult =
  | WebhookAccepted
  | WebhookHandshake
  | undefined;

export function isWebhookHandshake(
  result: WebhookAccepted | WebhookHandshake
): result is WebhookHandshake {
  return "handshake" in result;
}

/**
 * The two functions an integration writes to own its webhook.
 *
 * `TCredentials` is the integration's own credential record, so `verify` naming
 * a key the form never declared fails to compile.
 */
export type IntegrationWebhook<
  TCredentials extends Record<string, string | undefined> = Record<
    string,
    string | undefined
  >,
> = {
  readonly verify: (input: {
    readonly rawBody: string;
    readonly headers: Headers;
    readonly credentials: TCredentials;
  }) => Effect.Effect<void, SignatureRejected>;
  readonly receive: (
    body: JsonObject,
    headers: Headers
  ) => WebhookReceiveResult;
};
