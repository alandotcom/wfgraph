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

  // The tags a Send Email node set come back on every outbound email Event, and
  // a builder reads one by name. An open record is how the editor is told that a
  // key it could never list is still a path, so this is what makes
  // `data.tags.order_id` selectable in a Wait match or a Lifecycle Rule.
  it("offers each outbound email Event's tags as an open record of text", () => {
    const emailEvents = resendEvents.filter(
      (event) =>
        event.name.startsWith("resend/email.") &&
        event.name !== "resend/email.received"
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
        nullable: true,
      });
    }
  });

  // Resend documents `template_id` as "(if applicable)" and sends `email_id` on
  // every payload. The picker reads that difference off `nullable` alone: it
  // badges the field and offers `is set` and `is not set` on it, which is the
  // rule a builder wants for a send that may have used no template.
  it("marks the keys Resend omits nullable and the ones it always sends plain", () => {
    const delivered = resendEvents.find(
      (event) => event.name === "resend/email.delivered"
    );
    expect(delivered).toBeDefined();

    const nullableByPath = new Map(
      delivered!.payloadFields.map((field) => [
        field.path,
        field.nullable === true,
      ])
    );

    expect(nullableByPath.get("data.template_id")).toBe(true);
    expect(nullableByPath.get("data.broadcast_id")).toBe(true);
    expect(nullableByPath.get("data.tags")).toBe(true);
    expect(nullableByPath.get("data.email_id")).toBe(false);
    expect(nullableByPath.get("data.subject")).toBe(false);
    expect(nullableByPath.get("data.from")).toBe(false);
    expect(nullableByPath.get("data.message_id")).toBe(false);
  });

  it("offers the suppression details only email.suppressed carries", () => {
    const suppressed = resendEvents.find(
      (event) => event.name === "resend/email.suppressed"
    );
    expect(suppressed).toBeDefined();

    expect(suppressed!.payloadFields.map((field) => field.path)).toEqual(
      expect.arrayContaining([
        "data.suppressed",
        "data.suppressed.message",
        "data.suppressed.type",
      ])
    );
  });

  it("offers the raw SMTP responses on a bounce", () => {
    const bounced = resendEvents.find(
      (event) => event.name === "resend/email.bounced"
    );
    expect(bounced).toBeDefined();

    expect(bounced!.payloadFields.map((field) => field.path)).toContain(
      "data.bounce.diagnosticCode"
    );
  });

  // An inbound email shares none of the send-side keys, so offering them would
  // list three paths no `email.received` payload holds.
  it("offers an inbound email its own fields and none of the send-side keys", () => {
    const received = resendEvents.find(
      (event) => event.name === "resend/email.received"
    );
    expect(received).toBeDefined();

    const paths = received!.payloadFields.map((field) => field.path);
    expect(paths).toEqual(
      expect.arrayContaining(["data.cc", "data.bcc", "data.received_for"])
    );
    expect(paths).not.toContain("data.template_id");
    expect(paths).not.toContain("data.broadcast_id");
    expect(paths).not.toContain("data.tags");
  });

  // Every recorded fixture is the docs' own example, which carries each optional
  // key, so the decode cases above pass whether a field is required or not. What
  // pins the split is the payload that drops the optional keys and the payload
  // that drops a required one.
  const payloadWithout = (
    envelope: { readonly data: object },
    absent: readonly string[]
  ) => ({
    ...envelope,
    data: Object.fromEntries(
      Object.entries(envelope.data).filter(([key]) => !absent.includes(key))
    ),
  });

  const decode = async (eventName: string, payload: unknown) => {
    const event = resendEvents.find((each) => each.name === eventName);
    expect(event).toBeDefined();
    return await Effect.runPromise(
      event!.decodePayload(payload).pipe(
        Effect.match({
          onSuccess: () => null,
          onFailure: (failure) => failure,
        })
      )
    );
  };

  it("accepts a send that carried no broadcast, template or tags", async () => {
    await expect(
      decode(
        "resend/email.delivered",
        payloadWithout(resendWebhookFixtures["email.delivered"], [
          "broadcast_id",
          "template_id",
          "tags",
        ])
      )
    ).resolves.toBeNull();
  });

  it("refuses a send payload missing a key Resend always carries", async () => {
    await expect(
      decode(
        "resend/email.delivered",
        payloadWithout(resendWebhookFixtures["email.delivered"], ["subject"])
      )
    ).resolves.not.toBeNull();
  });

  it("accepts a contact with no audience, segments or names", async () => {
    await expect(
      decode(
        "resend/contact.created",
        payloadWithout(resendWebhookFixtures["contact.created"], [
          "audience_id",
          "segment_ids",
          "first_name",
          "last_name",
        ])
      )
    ).resolves.toBeNull();
  });

  it("accepts a domain payload that declares no capabilities", async () => {
    await expect(
      decode(
        "resend/domain.created",
        payloadWithout(resendWebhookFixtures["domain.created"], [
          "capabilities",
        ])
      )
    ).resolves.toBeNull();
  });

  // The docs list `diagnosticCode` and `resend-node`'s bounce type does not, so
  // a bounce without it has to decode.
  it("accepts a bounce carrying no diagnostic code", async () => {
    const { created_at, data } = resendWebhookFixtures["email.bounced"];
    await expect(
      decode("resend/email.bounced", {
        type: "email.bounced",
        created_at,
        data: {
          ...data,
          bounce: {
            message: "The recipient's mail server rejected the message.",
            subType: "Suppressed",
            type: "Permanent",
          },
        },
      })
    ).resolves.toBeNull();
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
