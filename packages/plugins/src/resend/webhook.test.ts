import { SignatureRejected, type JsonObject } from "@wfgraph/core/plugin";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Webhook } from "svix";
import { RESEND_WEBHOOK_SOURCE } from "#src/resend/events";
import { resendWebhook } from "#src/resend/webhook";
import { resendWebhookFixtures } from "#src/resend/webhook.fixtures";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function signedHeaders(rawBody: string): Headers {
  const id = "msg_p5jXN8AQM9LWM0D4loKWxJek";
  const unixSeconds = Math.floor(Date.now() / 1000);
  const timestamp = new Date(unixSeconds * 1000);
  const signature = new Webhook(SECRET).sign(id, timestamp, rawBody);
  return new Headers({
    "svix-id": id,
    "svix-timestamp": String(unixSeconds),
    "svix-signature": signature,
  });
}

describe("the Resend webhook", () => {
  it("verifies a recorded envelope against a Svix signature", async () => {
    const rawBody = JSON.stringify(resendWebhookFixtures["email.delivered"]);
    const headers = signedHeaders(rawBody);

    await expect(
      Effect.runPromise(
        resendWebhook.verify({
          rawBody,
          headers,
          credentials: { RESEND_WEBHOOK_SECRET: SECRET },
        })
      )
    ).resolves.toBeUndefined();
  });

  it("rejects a POST when the Connection has no signing secret", async () => {
    const rawBody = JSON.stringify(resendWebhookFixtures["email.delivered"]);
    const rejected = await Effect.runPromise(
      Effect.flip(
        resendWebhook.verify({
          rawBody,
          headers: signedHeaders(rawBody),
          credentials: {},
        })
      )
    );

    expect(rejected).toBeInstanceOf(SignatureRejected);
    expect(rejected.error).toBe(
      "This Connection has no webhook signing secret."
    );
  });

  it("rejects a raw body that is not the signed bytes", async () => {
    const rawBody = JSON.stringify(resendWebhookFixtures["email.delivered"]);
    const rejected = await Effect.runPromise(
      Effect.flip(
        resendWebhook.verify({
          rawBody: ` ${rawBody}`,
          headers: signedHeaders(rawBody),
          credentials: { RESEND_WEBHOOK_SECRET: SECRET },
        })
      )
    );

    expect(rejected).toBeInstanceOf(SignatureRejected);
  });

  it("sends a known type on the umbrella source with the svix-id", () => {
    const headers = new Headers({ "svix-id": "msg_p5jXN8AQM9LWM0D4loKWxJek" });
    const accepted = resendWebhook.receive(
      resendWebhookFixtures["email.delivered"] as JsonObject,
      headers
    );

    expect(accepted).toEqual({
      event: RESEND_WEBHOOK_SOURCE,
      data: resendWebhookFixtures["email.delivered"],
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    });
  });

  it("ignores an unknown type", () => {
    expect(
      resendWebhook.receive(
        {
          type: "email.unknown",
          created_at: "2026-02-22T23:41:12.126Z",
          data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618" },
        },
        new Headers()
      )
    ).toBeUndefined();
  });
});
