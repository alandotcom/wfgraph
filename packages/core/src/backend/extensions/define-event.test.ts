/**
 * The fixtures here are Effect Schema, which is what this repo writes and what a
 * plugin author writes. The claim that any Standard Schema library may define an
 * Event rides on `asStandardSchema`, and `standard-schema-compat.test.ts` in
 * @wfgraph/shared is where that bridge is tested against a foreign library.
 */
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineEvent } from "#src/backend/extensions/define-event";

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

  it("refuses reserved Correlation Path segments", () => {
    expect(() =>
      defineEvent({
        name: "app/appointment.created",
        schema: appointmentPayload,
        correlationPath: "appointment.constructor.id" as never,
      })
    ).toThrow(/correlation path containing a key reserved/u);
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

  it("carries no description for a field its author never described", () => {
    // A host's payload schema is written for validation, so most paths arrive
    // bare, and the editor renders each one as the path alone.
    const event = defineEvent({
      name: "app/fields.bare",
      schema: Schema.Struct({ appointmentId: Schema.String }),
    });

    expect(event.payloadFields).toStrictEqual([
      { path: "appointmentId", type: "string" },
    ]);
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

// The one option case that belongs to defineEvent: an Event that authored
// nothing carries nothing.
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

// A `source.when` that cannot become a CEL expression fails at definition rather
// than at sync time, which is what this covers here; the compiler's own escaping
// is `inngest-event-data.test.ts`.
describe("defineEvent source filters", () => {
  it("refuses a filter whose path is nothing", () => {
    expect(() =>
      defineEvent({
        name: "app/appointment.updated",
        schema: appointmentPayload,
        correlationPath: "appointment.id",
        // The path is typed against the payload, so an empty one needs the cast
        // a caller could only reach for deliberately.
        source: {
          event: "app/bus",
          when: { path: "" as "event", equals: "x" },
        },
      })
    ).toThrow("needs a payload path");
  });

  it("accepts a value with an apostrophe in it", () => {
    const event = defineEvent({
      name: "app/appointment.updated",
      schema: appointmentPayload,
      correlationPath: "appointment.id",
      source: { event: "app/bus", when: { path: "event", equals: "it's on" } },
    });

    expect(event.source.when).toEqual({ path: "event", equals: "it's on" });
  });
});

describe("the intake gate", () => {
  const appointmentCreated = defineEvent({
    name: "app/appointment.created",
    schema: appointmentPayload,
    correlationPath: "appointment.id",
  });

  const gate = (payload: unknown) =>
    Effect.runSync(
      appointmentCreated.decodePayload(payload).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (rejected) => rejected.error,
        })
      )
    );

  it("accepts the payload the schema describes", () => {
    expect(
      gate({
        event: "created",
        appointment: { id: "appt_1", priority: "high" },
      })
    ).toBeUndefined();
  });

  // An Event's payload is the host's own message and their senders add fields.
  // An additive change upstream must not stop intake.
  it("ignores a key the schema does not declare", () => {
    expect(
      gate({
        event: "created",
        appointment: { id: "appt_1", priority: "high" },
        traceId: "trace_9",
      })
    ).toBeUndefined();
  });

  // Drift on a declared field is the half that still fails loudly, and the
  // message is `formatSchemaFailure`'s: the path and what was expected of it.
  it("refuses a declared field of the wrong type, naming its path", () => {
    expect(gate({ event: 7, appointment: { id: "appt_1" } })).toBe(
      "event: Expected string; appointment.priority: Missing key"
    );
  });

  // An Effect payload schema renders through `formatSchemaFailure`, which holds
  // nothing of what arrived, so the sender's answer and the operator's log line
  // are the same string. A payload schema from a foreign library is the case
  // where the two still differ, because its own messages stay in `detail`.
  it("keeps the payload out of both the answer and the log line", () => {
    const rejected = Effect.runSync(
      appointmentCreated
        .decodePayload({ event: 7, appointment: { id: "appt_1" } })
        .pipe(
          Effect.match({
            onSuccess: () => undefined,
            onFailure: (failure) => failure,
          })
        )
    );

    expect(rejected?.error).not.toContain("7");
    expect(rejected?.detail).not.toContain("7");
    expect(rejected?.detail).toBe(rejected?.error);
  });
});

/**
 * The same gate over a payload schema this project did not write.
 *
 * An Event may be described in any Standard Schema library, and the gate then goes
 * through that library's own `validate` rather than through an Effect decode. The
 * fixture is hand-rolled rather than Zod or arktype because neither is a
 * dependency of this package -- `standard-schema-compat.test.ts` in @wfgraph/shared is
 * where the claim about those two libraries is made -- and what matters here is the
 * branch: a schema Effect does not recognise takes the other path.
 */
describe("the intake gate over a foreign schema", () => {
  const foreignSchema = {
    "~standard": {
      version: 1 as const,
      vendor: "handwritten",
      validate: (value: unknown) => {
        const declared =
          typeof value === "object" && value !== null && "appointment" in value
            ? (value as { appointment?: { id?: unknown } }).appointment
            : undefined;

        return typeof declared?.id === "string"
          ? { value: { appointment: { id: declared.id } } }
          : {
              issues: [
                {
                  message: "must be a string, was 7",
                  path: ["appointment", "id"],
                },
              ],
            };
      },
      jsonSchema: {
        input: () => ({
          type: "object",
          properties: {
            appointment: {
              type: "object",
              description: "The appointment this event is about",
              properties: {
                id: { type: "string", description: "Appointment ID" },
              },
            },
          },
        }),
        output: () => ({ type: "object" }),
      },
    },
  };

  const foreignEvent = defineEvent({
    name: "app/foreign.event",
    // The parameter admits any Standard Schema, and a hand-rolled one satisfies
    // the shape without satisfying the generic's inference.
    schema: foreignSchema as never,
    correlationPath: "appointment.id" as never,
  });

  const gate = (payload: unknown) =>
    Effect.runSync(
      foreignEvent.decodePayload(payload).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (rejected) => rejected.error,
        })
      )
    );

  it("accepts what the schema describes", () => {
    expect(gate({ appointment: { id: "appt_1" } })).toBeUndefined();
  });

  it("ignores a key the schema does not declare", () => {
    expect(
      gate({ appointment: { id: "appt_1" }, traceId: "trace_9" })
    ).toBeUndefined();
  });

  // Paths only. A foreign library is free to quote the value it rejected -- this
  // one does, in its own message -- and that message is not what travels.
  it("refuses a wrong-typed field without passing its message on", () => {
    const error = gate({ appointment: { id: 7 } });

    expect(error).toBe("Payload does not fit this Event at: appointment.id");
    expect(error).not.toContain("was 7");
  });

  // The library's own message never leaves the process, so the log keeps it: for
  // a foreign schema it is the only statement of what was expected.
  it("keeps the library's own message on the operator-facing string", () => {
    const rejected = Effect.runSync(
      foreignEvent.decodePayload({ appointment: { id: 7 } }).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (failure) => failure,
        })
      )
    );

    expect(rejected?.detail).toBe(
      "Payload does not fit this Event: appointment.id: must be a string, was 7"
    );
  });
});
