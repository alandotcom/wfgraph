/**
 * Resend webhook intake: Svix verify on the raw body, then map a known
 * envelope type onto the umbrella `resend/webhook` send.
 *
 * The API key cannot verify a Svix signature. A Connection without
 * `RESEND_WEBHOOK_SECRET` is send-only; a POST to it is 401. Resend has no
 * URL-challenge handshake. An unknown `type` is ignored (200, no send).
 */

import {
  type IntegrationWebhook,
  SignatureRejected,
} from "@wfgraph/core/plugin";
import { Effect } from "effect";
import { Webhook } from "svix";
import {
  RESEND_WEBHOOK_EVENT_TYPES,
  RESEND_WEBHOOK_SOURCE,
  type ResendWebhookEventType,
} from "#src/resend/events";

const knownTypes = new Set<string>(RESEND_WEBHOOK_EVENT_TYPES);

function isResendWebhookEventType(
  value: string
): value is ResendWebhookEventType {
  return knownTypes.has(value);
}

export const resendWebhook: IntegrationWebhook<{
  RESEND_WEBHOOK_SECRET?: string;
}> = {
  verify: ({ rawBody, headers, credentials }) => {
    const secret = credentials.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      return Effect.fail(
        new SignatureRejected({
          error: "This Connection has no webhook signing secret.",
        })
      );
    }

    return Effect.try({
      try: () => {
        new Webhook(secret).verify(rawBody, {
          "svix-id": headers.get("svix-id") ?? "",
          "svix-timestamp": headers.get("svix-timestamp") ?? "",
          "svix-signature": headers.get("svix-signature") ?? "",
        });
      },
      catch: () =>
        new SignatureRejected({
          error:
            "The webhook signature did not match this Connection's secret.",
        }),
    });
  },

  receive: (body, headers) => {
    const type = body.type;
    if (typeof type !== "string" || !isResendWebhookEventType(type)) {
      return undefined;
    }

    const svixId = headers.get("svix-id");
    return {
      event: RESEND_WEBHOOK_SOURCE,
      data: body,
      ...(svixId ? { id: svixId } : {}),
    };
  },
};
