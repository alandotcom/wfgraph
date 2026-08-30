import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  RESEND_WEBHOOK_EVENT_TYPES,
  RESEND_WEBHOOK_SOURCE,
  resendEvents,
} from "#src/resend/events";
import { resendWebhookFixtures } from "#src/resend/webhook.fixtures";

describe("Resend webhook Events", () => {
  it("declares all 19 official types under the umbrella source", () => {
    expect(resendEvents.map((event) => event.source.when?.equals)).toEqual([
      ...RESEND_WEBHOOK_EVENT_TYPES,
    ]);
    expect(
      resendEvents.every(
        (event) =>
          event.source.event === RESEND_WEBHOOK_SOURCE &&
          event.name === `resend/${event.source.when?.equals}`
      )
    ).toBe(true);
  });

  it.each(resendEvents)(
    "decodes the recorded $name envelope",
    async (event) => {
      const type = event.source.when?.equals;
      expect(type).toBeDefined();
      const fixture =
        resendWebhookFixtures[type as keyof typeof resendWebhookFixtures];

      await expect(
        Effect.runPromise(event.decodePayload(fixture))
      ).resolves.toBeUndefined();
    }
  );

  it("lets an extra envelope key through the intake gate", async () => {
    const delivered = resendEvents.find(
      (event) => event.name === "resend/email.delivered"
    );
    expect(delivered).toBeDefined();

    await expect(
      Effect.runPromise(
        delivered!.decodePayload({
          ...resendWebhookFixtures["email.delivered"],
          extra_vendor_field: "passes",
        })
      )
    ).resolves.toBeUndefined();
  });
});
