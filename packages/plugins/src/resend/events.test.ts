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

  // The tags a Send Email node set come back on every email Event, and a builder
  // reads one by name. An open record is how the editor is told that a key it
  // could never list is still a path, so this is what makes `data.tags.order_id`
  // selectable in a Wait match or a Lifecycle Rule.
  it("offers each email Event's tags as an open record of text", () => {
    const emailEvents = resendEvents.filter((event) =>
      event.name.startsWith("resend/email.")
    );
    expect(emailEvents.length).toBeGreaterThan(0);

    for (const event of emailEvents) {
      expect(
        event.payloadFields.find((field) => field.path === "data.tags")
      ).toEqual({
        path: "data.tags",
        description: "Email tags",
        type: "object",
        valueType: "string",
      });
    }
  });

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
