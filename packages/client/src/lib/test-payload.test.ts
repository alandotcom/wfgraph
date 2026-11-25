import { describe, expect, it } from "vitest";
import type { EventMetadata } from "@wfgraph/shared/extensions/catalog";
import {
  formValuesFromPayload,
  missingRequiredFields,
  nextTestPayloads,
  parseTestPayload,
  payloadFromFormValues,
  samplePayload,
  startingTestPayload,
  testPayloadFields,
} from "#src/lib/test-payload";

const appointmentCreated: EventMetadata = {
  name: "app/appointment.created",
  label: "Appointment created",
  correlationPath: "appointment.id",
  payloadFields: [
    { path: "appointment.id", label: "Appointment ID", type: "string" },
    { path: "appointment.startsAt", type: "timestamp" },
    { path: "appointment.seats", type: "number" },
    { path: "appointment.confirmed", type: "boolean", nullable: true },
    {
      path: "appointment.channel",
      type: "string",
      enumValues: ["sms", "email"],
      enumLabels: { sms: "Text message" },
    },
    { path: "appointment", type: "object" },
    { path: "attendees[0].name", type: "string" },
  ],
};

describe("testPayloadFields", () => {
  it("draws one control per declared type", () => {
    expect(testPayloadFields(appointmentCreated)).toEqual([
      {
        path: "appointment.id",
        label: "Appointment ID",
        control: "text",
        optional: false,
      },
      {
        path: "appointment.startsAt",
        label: "Starts at",
        control: "datetime",
        optional: false,
      },
      {
        path: "appointment.seats",
        label: "Seats",
        control: "number",
        optional: false,
      },
      {
        path: "appointment.confirmed",
        label: "Confirmed",
        control: "checkbox",
        optional: true,
      },
      {
        path: "appointment.channel",
        label: "Channel",
        control: "select",
        options: [
          { value: "sms", label: "Text message" },
          { value: "email", label: "email" },
        ],
        optional: false,
      },
    ]);
  });

  // A container and an array element have no single control to type into, so
  // the JSON pane is where they are written.
  it("leaves out a container and an array element", () => {
    const paths = testPayloadFields(appointmentCreated).map(
      (field) => field.path
    );

    expect(paths).not.toContain("appointment");
    expect(paths).not.toContain("attendees[0].name");
  });
});

describe("payloadFromFormValues", () => {
  const fields = testPayloadFields(appointmentCreated);

  it("nests each path where the Event declared it, coercing as it goes", () => {
    const payload = payloadFromFormValues(fields, {
      "appointment.id": "appt_1",
      "appointment.startsAt": "2026-08-01T18:00:00.000Z",
      "appointment.seats": "2",
      "appointment.confirmed": "true",
      "appointment.channel": "sms",
    });

    expect(payload).toEqual({
      appointment: {
        id: "appt_1",
        startsAt: "2026-08-01T18:00:00.000Z",
        seats: 2,
        confirmed: true,
        channel: "sms",
      },
    });
  });

  // A blank field is an absent key, so an optional path stays absent and a
  // required one is refused by the Event rather than sent as empty text.
  it("leaves a blank field out of the payload", () => {
    const payload = payloadFromFormValues(fields, {
      "appointment.id": "appt_1",
      "appointment.startsAt": "",
      "appointment.seats": "  ",
    });

    expect(payload).toEqual({ appointment: { id: "appt_1" } });
  });

  it("keeps what the base payload holds beside the form's own fields", () => {
    const payload = payloadFromFormValues(
      fields,
      { "appointment.id": "appt_2" },
      { attendees: [{ name: "Jane" }], appointment: { id: "appt_1" } }
    );

    expect(payload).toEqual({
      attendees: [{ name: "Jane" }],
      appointment: { id: "appt_2" },
    });
  });
});

describe("formValuesFromPayload", () => {
  it("round-trips a payload through the form", () => {
    const fields = testPayloadFields(appointmentCreated);
    const payload = {
      appointment: {
        id: "appt_1",
        startsAt: "2026-08-01T18:00:00.000Z",
        seats: 2,
        confirmed: false,
        channel: "email",
      },
    };

    expect(
      payloadFromFormValues(fields, formValuesFromPayload(fields, payload))
    ).toEqual(payload);
  });
});

describe("parseTestPayload", () => {
  it("reads an empty pane as an empty payload", () => {
    expect(parseTestPayload("  ")).toEqual({ ok: true, payload: {} });
  });

  it("names what is wrong with text that is not a JSON object", () => {
    expect(parseTestPayload("{oops")).toEqual({
      ok: false,
      error: "This is not valid JSON.",
    });
    expect(parseTestPayload("[1, 2]")).toEqual({
      ok: false,
      error: "A payload has to be a JSON object.",
    });
  });
});

describe("nextTestPayloads", () => {
  it("keeps the Events this run did not touch", () => {
    const current = {
      byEvent: { "app/appointment.rescheduled": { appointment: { id: "a" } } },
    };

    expect(
      nextTestPayloads(current, {
        eventName: "app/appointment.created",
        input: { appointment: { id: "b" } },
      })
    ).toEqual({
      byEvent: {
        "app/appointment.rescheduled": { appointment: { id: "a" } },
        "app/appointment.created": { appointment: { id: "b" } },
      },
    });
  });

  it("keeps an Event-less run's payload in its own slot", () => {
    expect(nextTestPayloads({}, { input: { plan: "premium" } })).toEqual({
      manual: { plan: "premium" },
    });
  });
});

describe("missingRequiredFields", () => {
  const fields = testPayloadFields(appointmentCreated);

  it("names each required field the payload leaves without a value, in declared order", () => {
    const missing = missingRequiredFields(fields, {
      appointment: { id: "appt_1", seats: null },
    });

    expect(missing.map((field) => field.path)).toEqual([
      "appointment.startsAt",
      "appointment.seats",
      "appointment.channel",
    ]);
  });

  it("lets a nullable field stay empty", () => {
    const missing = missingRequiredFields(fields, {});

    expect(missing.map((field) => field.path)).not.toContain(
      "appointment.confirmed"
    );
  });

  it("finds nothing missing once every required field holds a value", () => {
    expect(
      missingRequiredFields(fields, {
        appointment: {
          id: "appt_1",
          startsAt: "2026-11-25T09:00:00.000Z",
          seats: 0,
          channel: "sms",
        },
      })
    ).toEqual([]);
  });
});

describe("samplePayload", () => {
  const now = new Date("2026-11-25T10:00:00.000Z");

  it("gives every addressable field a value its declared type accepts", () => {
    expect(samplePayload(appointmentCreated, now)).toEqual({
      appointment: {
        id: "Sample Appointment ID",
        startsAt: "2026-11-25T10:00:00.000Z",
        seats: 1,
        confirmed: true,
        channel: "sms",
      },
    });
  });

  it("writes an address, a phone number or a URL where the key names one", () => {
    const contact: EventMetadata = {
      name: "app/contact.created",
      label: "Contact created",
      payloadFields: [
        { path: "contact.email", type: "string" },
        { path: "contact.phoneNumber", type: "string" },
        { path: "contact.profileUrl", type: "string" },
        { path: "contact.delay", type: "duration" },
        { path: "contact.tags", type: "array" },
      ],
    };

    expect(samplePayload(contact, now)).toEqual({
      contact: {
        email: "person@example.com",
        phoneNumber: "+15555550100",
        profileUrl: "https://example.com",
        delay: "1h",
        tags: [],
      },
    });
  });
});

describe("startingTestPayload", () => {
  const now = new Date("2026-11-25T10:00:00.000Z");

  it("prefers the payload the workflow kept over a sample", () => {
    expect(
      startingTestPayload({
        kept: { appointment: { id: "appt_1" } },
        event: appointmentCreated,
        now,
      })
    ).toEqual({ payload: { appointment: { id: "appt_1" } }, sample: false });
  });

  it("starts an Event the workflow kept nothing for on a sample", () => {
    expect(
      startingTestPayload({ kept: undefined, event: appointmentCreated, now })
        .sample
    ).toBe(true);
  });

  it("starts an Event-less run empty", () => {
    expect(
      startingTestPayload({ kept: undefined, event: undefined, now })
    ).toEqual({ payload: {}, sample: false });
  });
});

describe("payloadFromFormValues with a starting payload", () => {
  // The dialog keeps the payload it opened with as the base, so a cleared
  // field has to leave it, or the sample value would still be sent.
  it("drops a field the form left blank from the base", () => {
    const fields = testPayloadFields(appointmentCreated);
    const base = samplePayload(appointmentCreated, new Date());

    const payload = payloadFromFormValues(
      fields,
      { ...formValuesFromPayload(fields, base), "appointment.id": "" },
      base
    );

    expect(payload).not.toHaveProperty(["appointment", "id"]);
    expect(base).toHaveProperty(["appointment", "id"]);
  });
});
