/**
 * How an integration receives a vendor POST and turns it into an Event send.
 *
 * `verify` runs on the raw body, because Svix and every HMAC scheme are
 * sensitive to a single byte of re-serialization. `receive` then sees the
 * parsed JSON. The route reads the body once and hands both halves what they
 * need; nothing here consumes the Request.
 *
 * The Inngest source lives on the webhook, not on each `receive` return, so a
 * payload this integration chose to model cannot be sent under a name no Event
 * listens to. An ignored payload is `undefined`, which the route answers 200
 * rather than an error, so a vendor retry storm does not follow a subtype this
 * integration chose not to model.
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

/** An accepted payload, as `inngest.send` takes its `data` and idempotency key. */
export type WebhookAccepted = {
  readonly data: JsonObject;
  /** Inngest idempotency key. Resend sets this from `svix-id`. */
  readonly id?: string;
};

export type WebhookReceiveResult = WebhookAccepted | undefined;

/**
 * The two functions an integration writes to own its webhook, plus the bus
 * name every accepted payload is sent as.
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
  /**
   * The Inngest event name `receive` maps onto. Catalog Events listen on this
   * and narrow with `source.when`.
   */
  readonly source: string;
  /**
   * Shown under the copyable webhook URL. Absent, the field uses a generic
   * sentence. The editor adds the signing-secret instruction only when this
   * Connection does not yet hold `secret`.
   */
  readonly helpText?: string;
  /**
   * The Connection credential `verify` reads. The editor uses this to tell a
   * filled secret from a send-only Connection, instead of guessing from the
   * credential name.
   */
  readonly secret?: Extract<keyof TCredentials, string>;
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
