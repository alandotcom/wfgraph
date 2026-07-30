/**
 * The fixtures here are Effect Schema, which is what this repo writes and what a
 * plugin author writes. The claim that any Standard Schema library may define an
 * Event rides on `asStandardSchema`, and `standard-schema-compat.test.ts` in
 * @rova/shared is where that bridge is tested against a foreign library.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineEvent } from "#src/backend/lib/extensions/define-event";

const appointment = Schema.Struct({
  id: Schema.String.annotate({ description: "Appointment ID" }),
  priority: Schema.String.annotate({ description: "Appointment priority" }),
}).annotate({ description: "The appointment this event is about" });

const appointmentPayload = Schema.Struct({
  event: Schema.String.annotate({ description: "What happened" }),
  appointment,
});

describe("defineEvent identity", () => {
  it("defaults the label to the name and the source to the name", () => {
    const event = defineEvent({
      name: "app/appointment.created",
      schema: appointmentPayload,
      correlationPath: "appointment.id",
    });

    expect(event.kind).toBe("event");
    expect(event.label).toBe("app/appointment.created");
    expect(event.source).toEqual({ event: "app/appointment.created" });
    expect(event.correlationPath).toBe("appointment.id");
  });

  it("trims the name, the label and the Correlation Path", () => {
    const event = defineEvent({
      name: "  app/appointment.created  ",
      label: "  Appointment created  ",
      schema: appointmentPayload,
      correlationPath: "appointment.id",
    });

    expect(event.name).toBe("app/appointment.created");
    expect(event.label).toBe("Appointment created");
  });

  it("refuses a blank name", () => {
    expect(() =>
      defineEvent({ name: "   ", schema: appointmentPayload })
    ).toThrow("An Event's name must be a non-empty string");
  });

  // An Event with no Correlation Path is a real case: an unlimited-concurrency
  // workflow may start on one, and a Wait node may subscribe to it. The Workflow
  // Builder supplies a path in the Lifecycle panel when one is needed.
  it("allows an Event that declares no Correlation Path", () => {
    const event = defineEvent({
      name: "ops/nightly.tick",
      schema: appointmentPayload,
    });

    expect(event.correlationPath).toBeUndefined();
  });

  it("separates identity from transport for an umbrella bus", () => {
    const event = defineEvent({
      name: "appointment.canceled",
      schema: appointmentPayload,
      correlationPath: "appointment.id",
      source: {
        event: "app/appointment.updated",
        when: { path: "event", equals: "appointment.canceled" },
      },
    });

    expect(event.name).toBe("appointment.canceled");
    expect(event.source).toEqual({
      event: "app/appointment.updated",
      when: { path: "event", equals: "appointment.canceled" },
    });
  });
});

describe("defineEvent path typing", () => {
  it("accepts a path that resolves to a string in the payload schema", () => {
    defineEvent({
      name: "app/typed.ok",
      schema: appointmentPayload,
      correlationPath: "appointment.id",
    });
  });

  it("rejects a path that resolves to something other than a string", () => {
    defineEvent({
      name: "app/typed.bad",
      schema: appointmentPayload,
      // @ts-expect-error "appointment" is an object, not a string field.
      correlationPath: "appointment",
    });
  });

  it("rejects a path the payload does not declare", () => {
    defineEvent({
      name: "app/typed.missing",
      schema: appointmentPayload,
      // @ts-expect-error the payload has no "patient" field.
      correlationPath: "patient.id",
    });
  });
});

describe("defineEvent payload fields", () => {
  it("descends into a nested object, offering the leaves beside it", () => {
    const event = defineEvent({
      name: "app/fields.derived",
      schema: appointmentPayload,
      correlationPath: "appointment.id",
    });

    expect(event.payloadFields).toEqual([
      { path: "event", description: "What happened", type: "string" },
      {
        path: "appointment",
        description: "The appointment this event is about",
        type: "object",
      },
      { path: "appointment.id", description: "Appointment ID", type: "string" },
      {
        path: "appointment.priority",
        description: "Appointment priority",
        type: "string",
      },
    ]);
  });

  it("refuses a field carrying no description, naming the Event", () => {
    expect(() =>
      defineEvent({
        name: "app/fields.bare",
        schema: Schema.Struct({ id: Schema.String }),
      })
    ).toThrow('Event "app/fields.bare" cannot derive the fields the editor');
  });

  it("refuses a payload whose root is not an object", () => {
    expect(() =>
      defineEvent({
        // @ts-expect-error an array root has no named paths to offer.
        schema: Schema.Array(Schema.String),
        name: "app/fields.array",
      })
    ).toThrow('Event "app/fields.array" cannot derive the fields the editor');
  });
});

// What the translation itself does with an authored option is
// `cel/rewrite.test.ts`. This is the one case that belongs to defineEvent: an
// Event that authored nothing carries nothing.
describe("defineEvent Inngest options", () => {
  it("holds no options when the Event declares none", () => {
    const event = defineEvent({
      name: "app/plain",
      schema: appointmentPayload,
      correlationPath: "appointment.id",
    });

    expect(event.inngestFunctionOptions).toBeUndefined();
  });
});
