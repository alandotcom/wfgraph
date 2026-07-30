import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type {
  ActionMetadata,
  IntegrationMetadata,
} from "@rova/shared/extensions/catalog";
import { defineEvent } from "#src/backend/lib/extensions/define-event";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";

const appointmentPayload = Schema.Struct({
  appointment: Schema.Struct({
    id: Schema.String.annotate({ description: "Appointment ID" }),
  }).annotate({ description: "The appointment this event is about" }),
});

function anEvent(name: string, sourceEvent?: string) {
  return defineEvent({
    name,
    schema: appointmentPayload,
    correlationPath: "appointment.id",
    ...(sourceEvent ? { source: { event: sourceEvent } } : {}),
  });
}

function anAction(id: string, category = "Appointments"): ActionMetadata {
  return {
    id,
    label: id,
    description: `The ${id} action`,
    category,
    configFields: [],
    outputFields: [],
  };
}

function anIntegration(type: string): IntegrationMetadata {
  return {
    type,
    label: type,
    description: `The ${type} integration`,
    credentialFields: [],
    hasTest: false,
  };
}

describe("assembleExtensions", () => {
  it("assembles an empty surface when the host passes nothing", () => {
    const { catalog, sourceEventNames } = assembleExtensions({});

    expect(catalog.events).toEqual([]);
    expect(catalog.integrations).toEqual([]);
    expect(sourceEventNames).toEqual([]);
  });

  it("puts the four built-in actions in the catalog", () => {
    const { catalog } = assembleExtensions({});

    expect(catalog.actions.map((action) => action.id)).toEqual([
      "HTTP Request",
      "Database Query",
      "Condition",
      "Wait",
    ]);
  });

  it("lists a host's actions and integrations after the built-ins", () => {
    const { catalog } = assembleExtensions({
      actions: [anAction("appointments/cancel")],
      integrations: [anIntegration("twilio")],
    });

    expect(catalog.actions.at(-1)?.id).toBe("appointments/cancel");
    expect(catalog.integrations.map((one) => one.type)).toEqual(["twilio"]);
  });

  it("carries an Event's label, Correlation Path and payload fields into the catalog", () => {
    const { catalog } = assembleExtensions({
      events: [
        defineEvent({
          name: "app/appointment.created",
          label: "Appointment created",
          description: "Raised when a new appointment is booked.",
          schema: appointmentPayload,
          correlationPath: "appointment.id",
        }),
      ],
    });

    expect(catalog.events).toEqual([
      {
        name: "app/appointment.created",
        label: "Appointment created",
        description: "Raised when a new appointment is booked.",
        correlationPath: "appointment.id",
        payloadFields: [
          {
            path: "appointment",
            description: "The appointment this event is about",
            type: "object",
          },
          {
            path: "appointment.id",
            description: "Appointment ID",
            type: "string",
          },
        ],
      },
    ]);
  });

  // The catalog is served as JSON, where an undefined member is dropped, and the
  // wire schema accepts an absent key only. So the two have to agree here.
  it("leaves an undeclared description out rather than holding undefined", () => {
    const { catalog } = assembleExtensions({
      events: [anEvent("app/plain")],
    });

    expect(catalog.events[0]).not.toHaveProperty("description");
  });

  it("answers an Event by name, and undefined for one it does not hold", () => {
    const event = anEvent("app/appointment.created");
    const set = assembleExtensions({ events: [event] });

    expect(set.eventByName("app/appointment.created")).toBe(event);
    expect(set.eventByName("app/appointment.canceled")).toBeUndefined();
  });

  it("reports each distinct source event once, which is the listener set", () => {
    const set = assembleExtensions({
      events: [
        anEvent("appointment.created", "app/appointment.updated"),
        anEvent("appointment.canceled", "app/appointment.updated"),
        anEvent("billing/payment.settled"),
      ],
    });

    expect(set.sourceEventNames).toEqual([
      "app/appointment.updated",
      "billing/payment.settled",
    ]);
  });
});

describe("assembleExtensions checks", () => {
  it("refuses two Events sharing a name", () => {
    expect(() =>
      assembleExtensions({
        events: [
          anEvent("app/appointment.created"),
          anEvent("app/appointment.created"),
        ],
      })
    ).toThrow('Two Events are defined with the name "app/appointment.created"');
  });

  // A host listing an Event a plugin also declares is the ordinary case, so the
  // check is about two definitions, not two mentions of one.
  it("accepts one definition listed twice", () => {
    const event = anEvent("app/appointment.created");
    const { catalog } = assembleExtensions({ events: [event, event] });

    expect(catalog.events).toHaveLength(1);
  });

  it("refuses two actions sharing an id", () => {
    expect(() =>
      assembleExtensions({
        actions: [
          anAction("appointments/cancel"),
          anAction("appointments/cancel"),
        ],
      })
    ).toThrow('Two actions are defined with the id "appointments/cancel"');
  });

  it("refuses a host action that collides with a built-in", () => {
    expect(() =>
      assembleExtensions({ actions: [anAction("Condition", "System")] })
    ).toThrow('Two actions are defined with the id "Condition"');
  });

  it("refuses two integrations sharing a type", () => {
    expect(() =>
      assembleExtensions({
        integrations: [anIntegration("twilio"), anIntegration("twilio")],
      })
    ).toThrow('Two integrations are defined with the type "twilio"');
  });
});
