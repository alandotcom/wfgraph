import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { findIntegration } from "@rova/shared/extensions/catalog";
import { createAction } from "@rova/shared/workflow/action-registry";
import { defineEvent } from "#src/backend/lib/extensions/define-event";
import {
  defineIntegration,
  type IntegrationDefinition,
} from "#src/backend/lib/extensions/define-integration";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import { defineStep } from "#src/backend/lib/steps/define-step";

const appointmentPayload = Schema.Struct({
  appointment: Schema.Struct({
    id: Schema.String.annotate({ description: "Appointment ID" }),
  }).annotate({ description: "The appointment this event is about" }),
  kind: Schema.String.annotate({ description: "Which thing happened" }),
});

function anEvent(
  name: string,
  source?: { event: string; when?: { path: "kind"; equals: string } }
) {
  return defineEvent({
    name,
    schema: appointmentPayload,
    correlationPath: "appointment.id",
    ...(source ? { source } : {}),
  });
}

/** A host's own action, which carries its `execute` into the set. */
function anAction(id: string, category = "Appointments") {
  return createAction({
    id,
    label: id,
    description: `The ${id} action`,
    category,
    schema: Schema.Struct({ appointmentId: Schema.String }),
    execute: ({ payload }) => ({ success: true, data: { echoed: payload } }),
  });
}

const sendSmsHandler = Effect.fn(function* () {
  return yield* Effect.succeed({ sid: "SM1" });
});

/**
 * A step whose schemas and config form agree, which is what the two checks over
 * an action's schemas are satisfied by. A case exercising one of them writes its
 * own `defineStep` with the schemas that break it.
 */
function aStep() {
  return defineStep({
    label: "Send SMS",
    description: "Sends a message",
    category: "Twilio",
    input: Schema.Struct({ to: Schema.String }),
    output: Schema.Struct({
      sid: Schema.String.annotate({ description: "Message SID" }),
    }),
    configFields: [
      { key: "to", label: "To", type: "template-input", required: true },
    ],
    handler: sendSmsHandler,
  });
}

function aDefinition(
  type: string,
  overrides: Partial<IntegrationDefinition> = {}
): IntegrationDefinition {
  return defineIntegration({
    type,
    label: type,
    description: `The ${type} integration`,
    credentials: [],
    actions: { "send-sms": aStep() },
    ...overrides,
  });
}

describe("assembleExtensions", () => {
  it("assembles an empty surface when the host passes nothing", () => {
    const { catalog, events } = assembleExtensions({});

    expect(catalog.events).toEqual([]);
    expect(events).toEqual([]);
  });

  // The database connection the engine's own Database Query action runs against is
  // a catalog entry, so the connections dialog reads it from the same place it
  // reads every other integration and nothing spells it out twice.
  it("puts the database integration in the catalog", () => {
    const { catalog, connectionTestFor } = assembleExtensions({});

    expect(catalog.integrations).toEqual([
      expect.objectContaining({
        type: "database",
        label: "Database",
        hasTest: true,
      }),
    ]);
    expect(connectionTestFor("database")).toBeDefined();
  });

  // The URL is what a Database Query step reads as DATABASE_URL, and it is marked a
  // password so the masking layer treats a stored connection string as a secret.
  it("declares the database URL as a secret credential field", () => {
    const { catalog } = assembleExtensions({});

    expect(catalog.integrations[0]?.credentialFields).toEqual([
      expect.objectContaining({
        configKey: "url",
        envVar: "DATABASE_URL",
        type: "password",
      }),
    ]);
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

  it("lists a host's own actions after the built-ins", () => {
    const { catalog } = assembleExtensions({
      actions: [anAction("appointments/cancel")],
    });

    expect(catalog.actions.at(-1)?.id).toBe("appointments/cancel");
  });

  // A host action is a step the engine calls like any other, which is the whole of
  // what dispatch needs to know about it. The context is what the engine puts in
  // the record, and the action id is what `stepFor` is keyed on.
  it("answers with a step for a host's own action", async () => {
    const set = assembleExtensions({
      actions: [anAction("appointments/cancel")],
    });

    const step = set.stepFor("appointments/cancel");

    expect(
      await step?.({
        appointmentId: "appt_1",
        _context: {
          nodeId: "action_1",
          nodeName: "Cancel",
          nodeType: "action",
        },
      })
    ).toEqual({
      success: true,
      data: { echoed: { appointmentId: "appt_1" } },
    });
  });

  it("has no step for an action nothing declared", () => {
    expect(assembleExtensions({}).stepFor("nobody/knows")).toBeUndefined();
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
          {
            path: "kind",
            description: "Which thing happened",
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

  // One listener per Event, so what the set hands back is the Events themselves.
  // Several may share a source name and each narrows it with its own filter.
  it("holds every Event, which is the listener set", () => {
    const set = assembleExtensions({
      events: [
        anEvent("appointment.created", {
          event: "app/appointment.updated",
          when: { path: "kind", equals: "created" },
        }),
        anEvent("appointment.canceled", {
          event: "app/appointment.updated",
          when: { path: "kind", equals: "canceled" },
        }),
        anEvent("billing/payment.settled"),
      ],
    });

    expect(set.events.map((event) => event.name)).toEqual([
      "appointment.created",
      "appointment.canceled",
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
      assembleExtensions({
        actions: [anAction("Condition", "System")],
      })
    ).toThrow('Two actions are defined with the id "Condition"');
  });

  it("refuses two integrations sharing a type", () => {
    expect(() =>
      assembleExtensions({
        integrations: [
          aDefinition("twilio"),
          // A second definition of one type collides on its actions too, so this
          // one declares a different action and leaves the type as the only clash.
          aDefinition("twilio", { actions: { "lookup-number": aStep() } }),
        ],
      })
    ).toThrow('Two integrations are defined with the type "twilio"');
  });

  // Two Events on one source have to be told apart by their payloads. Neither
  // narrowing means both are delivered for every payload: one arrival counted
  // twice.
  it("refuses two Events on one source that neither narrows", () => {
    expect(() =>
      assembleExtensions({
        events: [
          anEvent("appointment.created", { event: "app/appointment.updated" }),
          anEvent("appointment.canceled", { event: "app/appointment.updated" }),
        ],
      })
    ).toThrow("neither narrows it with source.when");
  });

  it("accepts two Events on one source when each narrows it", () => {
    expect(() =>
      assembleExtensions({
        events: [
          anEvent("appointment.created", {
            event: "app/appointment.updated",
            when: { path: "kind", equals: "created" },
          }),
          anEvent("appointment.canceled", {
            event: "app/appointment.updated",
            when: { path: "kind", equals: "canceled" },
          }),
        ],
      })
    ).not.toThrow();
  });

  // The listener id is the Event name slugged, so two names differing only in
  // punctuation are one function to Inngest: it would sync one and drop the other.
  it("refuses two Events whose names slug to one listener id", () => {
    expect(() =>
      assembleExtensions({
        events: [
          anEvent("app/appointment.created"),
          anEvent("app-appointment-created"),
        ],
      })
    ).toThrow("both name the Inngest function");
  });
});

/**
 * What an integration definition contributes, and the two checks that read the
 * schemas only a definition carries.
 */
describe("assembleExtensions and an integration definition", () => {
  it("computes each action id from the type and the record key", () => {
    const { catalog } = assembleExtensions({
      integrations: [aDefinition("twilio")],
    });

    expect(catalog.actions.at(-1)).toEqual({
      id: "twilio/send-sms",
      label: "Send SMS",
      description: "Sends a message",
      category: "Twilio",
      integration: "twilio",
      configFields: [
        { key: "to", label: "To", type: "template-input", required: true },
      ],
      outputFields: [
        { path: "sid", description: "Message SID", type: "string" },
      ],
    });
  });

  it("answers the step for an action id, and nothing for one it does not hold", async () => {
    const set = assembleExtensions({ integrations: [aDefinition("twilio")] });

    expect(
      await set.stepFor("twilio/send-sms")?.({ to: "+15550001111" })
    ).toEqual({
      success: true,
      data: { sid: "SM1" },
    });
    expect(set.stepFor("twilio/lookup-number")).toBeUndefined();
  });

  it("says an integration has a test when it carries a loader, and answers it", async () => {
    const testTwilio = () => Promise.resolve({ success: true });
    const set = assembleExtensions({
      integrations: [
        aDefinition("twilio", { test: () => Promise.resolve(testTwilio) }),
      ],
    });

    expect(findIntegration(set.catalog, "twilio")?.hasTest).toBe(true);
    expect(await set.connectionTestFor("twilio")?.()).toBe(testTwilio);
  });

  it("says an integration has no test when it carries no loader", () => {
    const set = assembleExtensions({ integrations: [aDefinition("twilio")] });

    expect(findIntegration(set.catalog, "twilio")?.hasTest).toBe(false);
    expect(set.connectionTestFor("twilio")).toBeUndefined();
  });

  it("carries the credential form into the catalog", () => {
    const { catalog } = assembleExtensions({
      integrations: [
        aDefinition("twilio", {
          credentials: [
            {
              label: "Auth Token",
              type: "password",
              configKey: "authToken",
              envVar: "TWILIO_AUTH_TOKEN",
            },
          ],
        }),
      ],
    });

    expect(findIntegration(catalog, "twilio")?.credentialFields).toEqual([
      {
        label: "Auth Token",
        type: "password",
        configKey: "authToken",
        envVar: "TWILIO_AUTH_TOKEN",
      },
    ]);
  });

  // Check 4. The message names the action, because a schema the derivation cannot
  // read is a mistake in the definition and the id is the only thing that says
  // which definition.
  it("refuses an action whose output schema it cannot derive fields from", () => {
    expect(() =>
      assembleExtensions({
        integrations: [
          aDefinition("twilio", {
            actions: {
              "send-sms": defineStep({
                label: "Send SMS",
                description: "Sends a message",
                category: "Twilio",
                input: Schema.Struct({ to: Schema.String }),
                // No description on the field, so the editor would list a path
                // with nothing to say about it.
                output: Schema.Struct({ sid: Schema.String }),
                configFields: [
                  {
                    key: "to",
                    label: "To",
                    type: "template-input",
                    required: true,
                  },
                ],
                handler: sendSmsHandler,
              }),
            },
          }),
        ],
      })
    ).toThrow(
      'Action "twilio/send-sms" cannot derive the fields the editor offers'
    );
  });

  // Check 5. The compiler holds every declared field to a key the schema names;
  // this is the half that catches a field nobody wrote, which would be a node
  // whose config decode fails on every run.
  it("refuses an action with a required config key no field fills in", () => {
    expect(() =>
      assembleExtensions({
        integrations: [
          aDefinition("twilio", {
            actions: {
              "send-sms": defineStep({
                label: "Send SMS",
                description: "Sends a message",
                category: "Twilio",
                input: Schema.Struct({
                  to: Schema.String,
                  body: Schema.String,
                }),
                output: Schema.Struct({
                  sid: Schema.String.annotate({ description: "Message SID" }),
                }),
                configFields: [
                  {
                    key: "to",
                    label: "To",
                    type: "template-input",
                    required: true,
                  },
                ],
                handler: sendSmsHandler,
              }),
            },
          }),
        ],
      })
    ).toThrow(
      'Action "twilio/send-sms" cannot run without the config keys body'
    );
  });

  it("counts a field inside a group as filling its key", () => {
    expect(() =>
      assembleExtensions({
        integrations: [
          aDefinition("twilio", {
            actions: {
              "send-sms": defineStep({
                label: "Send SMS",
                description: "Sends a message",
                category: "Twilio",
                input: Schema.Struct({
                  to: Schema.String,
                  body: Schema.String,
                }),
                output: Schema.Struct({
                  sid: Schema.String.annotate({ description: "Message SID" }),
                }),
                configFields: [
                  {
                    key: "to",
                    label: "To",
                    type: "template-input",
                    required: true,
                  },
                  {
                    type: "group",
                    label: "Message",
                    fields: [
                      {
                        key: "body",
                        label: "Body",
                        type: "text",
                        required: true,
                      },
                    ],
                  },
                ],
                handler: sendSmsHandler,
              }),
            },
          }),
        ],
      })
    ).not.toThrow();
  });
});
