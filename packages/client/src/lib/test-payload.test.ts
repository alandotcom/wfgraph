import { describe, expect, it } from "vitest";
import type { EventMetadata } from "@rova/shared/extensions/catalog";
import {
  formValuesFromPayload,
  nextTestPayloads,
  parseTestPayload,
  payloadFromFormValues,
  testPayloadFields,
} from "#src/lib/test-payload";

const appointmentCreated: EventMetadata = {
  name: "app/appointment.created",
  label: "Appointment created",
  correlationPath: "appointment.id",
  payloadFields: [
    { path: "appointment.id", type: "string" },
    { path: "appointment.startsAt", type: "timestamp", format: "timestamp" },
    { path: "appointment.seats", type: "number" },
    { path: "appointment.confirmed", type: "boolean", nullable: true },
    {
      path: "appointment.channel",
      type: "string",
      enumValues: ["sms", "email"],
    },
    { path: "appointment", type: "object" },
    { path: "attendees[0].name", type: "string" },
  ],
};

describe("testPayloadFields", () => {
  it("draws one control per declared type", () => {
    expect(testPayloadFields(appointmentCreated)).toEqual([
      { path: "appointment.id", control: "text", optional: false },
      { path: "appointment.startsAt", control: "datetime", optional: false },
      { path: "appointment.seats", control: "number", optional: false },
      { path: "appointment.confirmed", control: "checkbox", optional: true },
      {
        path: "appointment.channel",
        control: "select",
        options: ["sms", "email"],
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
