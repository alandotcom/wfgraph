import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { findIntegration } from "@wfgraph/shared/extensions/catalog";
import { defineAction } from "#src/backend/extensions/define-action";
import { defineEvent } from "#src/backend/extensions/define-event";
import { CONNECTION_STAMP_KEY } from "#src/backend/lib/inngest/catalog-connection";
import {
  defineIntegration,
  type IntegrationDefinition,
} from "#src/backend/extensions/define-integration";
import type { IntegrationTestLoader } from "#src/backend/extensions/integration-test";
import type { ConfigOptionsProvider } from "#src/backend/extensions/config-options";
import { stubStepEnvironment } from "#src/backend/lib/effect/test-layers";
import { assembleExtensions } from "#src/backend/extensions/extension-set";

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

/** A host's own action, which carries its step into the set. */
function anAction(id: string, category = "Appointments") {
  return defineAction({
    id,
    label: id,
    description: `The ${id} action`,
    category,
    input: Schema.Struct({ appointmentId: Schema.String }),
    handler: ({ input }) => ({ echoed: input }),
  });
}

const sendSmsHandler = Effect.fn(function* () {
  return yield* Effect.succeed({ sid: "SM1" });
});

/**
 * An integration whose one action's schemas and config form agree, which is what
 * the two checks over an action's schemas are satisfied by. A case exercising one
 * of them writes its own `defineIntegration` with the schemas that break it.
 *
 * The action is written inline rather than hoisted into a helper: a hoisted
 * action literal has no contextual type, so its config fields widen and it stops
 * fitting the slot it was written for.
 */
function aDefinition(
  type: string,
  overrides: { slug?: string; test?: IntegrationTestLoader } = {}
): IntegrationDefinition {
  return defineIntegration({
    type,
    label: type,
    description: `The ${type} integration`,
    credentials: {},
    test: overrides.test,
    actions: {
      [overrides.slug ?? "send-sms"]: {
        label: "Send SMS",
        description: "Sends a message",
        sideEffect: true,
        input: Schema.Struct({ to: Schema.String }),
        output: Schema.Struct({
          sid: Schema.String.annotate({ description: "Message SID" }),
        }),
        configFields: [
          { key: "to", label: "To", type: "template-input", required: true },
        ],
        handler: sendSmsHandler,
      },
    },
  });
}

describe("assembleExtensions", () => {
  it.each(["__proto__", "prototype", "constructor"])(
    "refuses the reserved integration action slug %s",
    (slug) => {
      const action = {
        label: "Unsafe",
        description: "Uses a reserved slug",
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        handler: () => ({ value: "ok" }),
      };

      expect(() =>
        defineIntegration({
          type: "unsafe",
          label: "Unsafe",
          description: "Unsafe",
          credentials: {},
          actions: Object.fromEntries([[slug, action]]) as never,
        })
      ).toThrow(/action slug reserved by JavaScript objects/u);
    }
  );

  it("refuses a host action whose schema derives a reserved config key", () => {
    const action = defineAction({
      id: "appointments/unsafe",
      label: "Unsafe",
      description: "Uses a reserved key",
      input: Schema.Struct({
        constructor: Schema.String.annotate({ description: "Unsafe" }),
      }),
      handler: () => undefined,
    });

    expect(() => assembleExtensions({ actions: [action] })).toThrow(
      /config field with a key reserved by JavaScript objects/u
    );
  });

  it("assembles an empty surface when the host passes nothing", () => {
    const { catalog, events } = assembleExtensions({});

    expect(catalog.events).toEqual([]);
    expect(events).toEqual([]);
    // No integration is a built-in any more: a host naming none gets none.
    expect(catalog.integrations).toEqual([]);
  });

  it("puts the built-in actions in the catalog", () => {
    const { catalog } = assembleExtensions({});

    expect(catalog.actions.map((action) => action.id)).toEqual([
      "Condition",
      "Event Split",
      "Wait",
    ]);
  });

  // The Wait node is the only node with no output schema behind it, so this
  // list is the whole of what the template picker and the condition builder can
  // offer for it. It has to name what `executeEventWait` writes.
  it("offers the Wait node's own output paths", () => {
    const { catalog } = assembleExtensions({});
    const wait = catalog.actions.find((action) => action.id === "Wait");

    expect(wait?.outputFields.map((field) => field.path)).toEqual([
      "waitType",
      "timedOut",
      "resumedAt",
      "event",
      "payload",
    ]);
  });

  it("has no step for either built-in, since the engine dispatches to them itself", () => {
    const { stepFor } = assembleExtensions({});

    expect(stepFor("Condition")).toBeUndefined();
    expect(stepFor("Wait")).toBeUndefined();
  });

  it("carries hidden on a host action the picker omits", () => {
    const { catalog, stepFor } = assembleExtensions({
      actions: [
        defineAction({
          id: "appointments/cancel-legacy",
          label: "Cancel (legacy)",
          description: "Retired cancel",
          category: "Appointments",
          hidden: true,
          input: Schema.Struct({ appointmentId: Schema.String }),
          handler: ({ input }) => ({ echoed: input }),
        }),
      ],
    });

    const hidden = catalog.actions.find(
      (action) => action.id === "appointments/cancel-legacy"
    );

    expect(hidden?.hidden).toBe(true);
    expect(stepFor("appointments/cancel-legacy")).toBeDefined();
  });

  it("carries hidden on an integration action the picker omits", () => {
    const { catalog, stepFor } = assembleExtensions({
      integrations: [
        defineIntegration({
          type: "twilio",
          label: "Twilio",
          description: "Sends messages",
          credentials: {},
          actions: {
            "send-sms-legacy": {
              label: "Send SMS (legacy)",
              description: "Retired",
              hidden: true,
              input: Schema.Struct({ to: Schema.String }),
              output: Schema.Struct({
                sid: Schema.String.annotate({ description: "Message SID" }),
              }),
              handler: sendSmsHandler,
            },
          },
        }),
      ],
    });

    const hidden = catalog.actions.find(
      (action) => action.id === "twilio/send-sms-legacy"
    );

    expect(hidden?.hidden).toBe(true);
    expect(stepFor("twilio/send-sms-legacy")).toBeDefined();
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

    const step = set.stepFor("appointments/cancel")?.(stubStepEnvironment());

    expect(
      step
        ? await Effect.runPromise(
            step({
              appointmentId: "appt_1",
              _context: {
                nodeId: "action_1",
                nodeName: "Cancel",
                nodeType: "action",
              },
            })
          )
        : undefined
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
          aDefinition("twilio", { slug: "lookup-number" }),
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
  it("keeps an OAuth adapter server-side and carries only its label into the catalog", () => {
    const oauth = {
      label: "Connect with Twilio",
      registerClient: () => ({
        clientId: "client-id",
        clientSecret: "client-secret",
      }),
      authorize: () => new URL("https://example.com/oauth/authorize"),
      exchange: () =>
        Promise.resolve({
          credentials: { TWILIO_AUTH_TOKEN: "access-token" },
          tokens: { accessToken: "access-token" },
        }),
      refresh: () =>
        Promise.resolve({
          credentials: { TWILIO_AUTH_TOKEN: "new-access-token" },
          tokens: { accessToken: "new-access-token" },
        }),
      revoke: () => Promise.resolve(),
    };
    const definition = defineIntegration({
      type: "twilio",
      label: "Twilio",
      description: "Sends messages",
      credentials: {
        TWILIO_AUTH_TOKEN: { label: "Auth Token", type: "password" },
      },
      oauth,
      actions: {},
    });

    const set = assembleExtensions({ integrations: [definition] });

    expect(findIntegration(set.catalog, "twilio")?.oauth).toEqual({
      label: "Connect with Twilio",
    });
    expect(set.oauthFor("twilio")).toBe(oauth);
    expect(JSON.stringify(set.catalog)).not.toContain("client-secret");
  });

  it("refuses an OAuth capability with a blank label", () => {
    expect(() =>
      assembleExtensions({
        integrations: [
          defineIntegration({
            type: "twilio",
            label: "Twilio",
            description: "Sends messages",
            credentials: {},
            oauth: {
              label: "  ",
              registerClient: () => ({ clientId: "client-id" }),
              authorize: () => new URL("https://example.com/oauth/authorize"),
              exchange: () =>
                Promise.resolve({
                  credentials: {},
                  tokens: { accessToken: "access-token" },
                }),
              refresh: () =>
                Promise.resolve({
                  credentials: {},
                  tokens: { accessToken: "new-access-token" },
                }),
              revoke: () => Promise.resolve(),
            },
            actions: {},
          }),
        ],
      })
    ).toThrow('Integration "twilio" declares OAuth without a label');
  });

  it("computes each action id from the type and the record key", () => {
    const { catalog } = assembleExtensions({
      integrations: [aDefinition("twilio")],
    });

    expect(catalog.actions.at(-1)).toEqual({
      id: "twilio/send-sms",
      label: "Send SMS",
      description: "Sends a message",
      // The action named no heading, so it takes the integration's own label,
      // which this fixture spells with its type.
      category: "twilio",
      integration: "twilio",
      // Declared on the action; the Group rule in the editor reads it.
      sideEffect: true,
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
    const step = set.stepFor("twilio/send-sms")?.(stubStepEnvironment());

    expect(
      step
        ? await Effect.runPromise(
            step({
              to: "+15550001111",
              _context: {
                executionId: "exec_1",
                nodeId: "n1",
                nodeName: "Send SMS",
                nodeType: "action",
                runMode: "live",
              },
            })
          )
        : undefined
    ).toEqual({
      success: true,
      data: { sid: "SM1" },
    });
    expect(set.stepFor("twilio/lookup-number")).toBeUndefined();
  });

  it("says an integration has a test when it carries a loader, and answers it", async () => {
    const testTwilio = () => Promise.resolve({ success: true as const });
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
    expect(findIntegration(set.catalog, "twilio")?.hasWebhook).toBe(false);
    expect(set.connectionTestFor("twilio")).toBeUndefined();
    expect(set.webhookFor("twilio")).toBeUndefined();
  });

  it("folds an integration's Events into the catalog and stamps the owner", () => {
    const delivered = defineEvent({
      name: "resend/email.delivered",
      label: "Email delivered",
      schema: Schema.Struct({
        type: Schema.String,
        data: Schema.Struct({
          email_id: Schema.String.annotate({ description: "Email ID" }),
        }),
      }),
      correlationPath: "data.email_id",
      source: {
        event: "resend/webhook",
        when: { path: "type", equals: "email.delivered" },
      },
    });
    const webhook = {
      source: "resend/webhook",
      helpText: "Paste this URL into Resend.",
      secret: "RESEND_WEBHOOK_SECRET" as const,
      verify: () => Effect.void,
      receive: () => undefined,
    };
    const set = assembleExtensions({
      integrations: [
        defineIntegration({
          type: "resend",
          label: "Resend",
          description: "Sends email",
          credentials: {
            RESEND_WEBHOOK_SECRET: {
              label: "Webhook Signing Secret",
              type: "password",
            },
          },
          actions: {},
          events: [delivered],
          webhook,
        }),
      ],
    });

    expect(set.catalog.events).toEqual([
      expect.objectContaining({
        name: "resend/email.delivered",
        label: "Email delivered",
        integration: "resend",
        correlationPath: "data.email_id",
      }),
    ]);
    expect(findIntegration(set.catalog, "resend")?.hasWebhook).toBe(true);
    expect(findIntegration(set.catalog, "resend")?.webhookHelpText).toBe(
      "Paste this URL into Resend."
    );
    expect(findIntegration(set.catalog, "resend")?.webhookSecretKey).toBe(
      "RESEND_WEBHOOK_SECRET"
    );
    expect(set.webhookFor("resend")).toBe(webhook);
    expect(set.eventByName("resend/email.delivered")).toBe(delivered);
  });

  // One `defineEvent` result listed by the host and by a plugin is the ordinary
  // case: the plugin declared it, the host passed the plugin, and may also list
  // it under `events`. Identity, not a second definition, is what keeps it.
  it("keeps one Event when the host lists the same object an integration declared", () => {
    const event = anEvent("resend/email.delivered", {
      event: "resend/webhook",
      when: { path: "kind", equals: "email.delivered" },
    });
    const set = assembleExtensions({
      events: [event],
      integrations: [
        defineIntegration({
          type: "resend",
          label: "Resend",
          description: "Sends email",
          credentials: {},
          actions: {},
          events: [event],
        }),
      ],
    });

    expect(set.events).toEqual([event]);
    expect(set.catalog.events[0]?.integration).toBe("resend");
  });

  it("refuses one Event object claimed by two integrations", () => {
    // Identity-equal, so indexEvents keeps it once; without this the owner would
    // be whichever integration was declared last, and the catalog would offer
    // only that one's Connections.
    const event = anEvent("shared/email.delivered", {
      event: "shared/webhook",
    });
    const claiming = (type: string) =>
      defineIntegration({
        type,
        label: type,
        description: `The ${type} integration`,
        credentials: {},
        actions: {},
        events: [event],
      });

    expect(() =>
      assembleExtensions({
        integrations: [claiming("resend"), claiming("postmark")],
      })
    ).toThrow(
      /Event "shared\/email.delivered" is declared by integrations "resend" and "postmark"/
    );
  });

  it("refuses an integration Event declaring a field at the Connection stamp key", () => {
    // The stamp is written onto `data` on the way out and removed on the way
    // in, so a field declared there would never reach a condition or template.
    expect(() =>
      assembleExtensions({
        integrations: [
          defineIntegration({
            type: "resend",
            label: "Resend",
            description: "Sends email",
            credentials: {},
            actions: {},
            events: [
              defineEvent({
                name: "resend/email.delivered",
                schema: Schema.Struct({
                  [CONNECTION_STAMP_KEY]: Schema.String,
                }),
              }),
            ],
          }),
        ],
      })
    ).toThrow(
      /reserves for the Connection an integration Event arrived through/
    );
  });

  it("leaves a host Event free to declare that key", () => {
    // Nothing stamps a host Event, so the key carries no meaning there.
    const set = assembleExtensions({
      events: [
        defineEvent({
          name: "app/anything",
          schema: Schema.Struct({ [CONNECTION_STAMP_KEY]: Schema.String }),
        }),
      ],
    });

    expect(set.catalog.events[0]?.name).toBe("app/anything");
  });

  it("refuses an integration Event whose name collides with a different host Event", () => {
    expect(() =>
      assembleExtensions({
        events: [anEvent("resend/email.delivered")],
        integrations: [
          defineIntegration({
            type: "resend",
            label: "Resend",
            description: "Sends email",
            credentials: {},
            actions: {},
            events: [anEvent("resend/email.delivered")],
          }),
        ],
      })
    ).toThrow(/Two Events are defined with the name "resend\/email.delivered"/);
  });

  it("carries the credential form into the catalog", () => {
    const { catalog } = assembleExtensions({
      integrations: [
        defineIntegration({
          type: "twilio",
          label: "Twilio",
          description: "Sends messages",
          credentials: {
            TWILIO_AUTH_TOKEN: { label: "Auth Token", type: "password" },
          },
          actions: {},
        }),
      ],
    });

    expect(findIntegration(catalog, "twilio")?.credentialFields).toEqual({
      TWILIO_AUTH_TOKEN: { label: "Auth Token", type: "password" },
    });
  });

  // Check 4. The message names the action, because a schema the derivation cannot
  // read is a mistake in the definition and the id is the only thing that says
  // which definition.
  it("refuses an action whose output schema it cannot derive fields from", () => {
    expect(() =>
      assembleExtensions({
        integrations: [
          defineIntegration({
            type: "twilio",
            label: "Twilio",
            description: "Sends messages",
            credentials: {},
            actions: {
              "send-sms": {
                label: "Send SMS",
                description: "Sends a message",
                input: Schema.Struct({ to: Schema.String }),
                // `Schema.Number` admits NaN and the two infinities, which JSON
                // Schema cannot express, so the field is dropped from the
                // derived list and the editor would offer a shorter one than
                // the step returns.
                output: Schema.Struct({
                  sid: Schema.String,
                  attempts: Schema.Number,
                }),
                configFields: [
                  {
                    key: "to",
                    label: "To",
                    type: "template-input",
                    required: true,
                  },
                ],
                handler: () => Effect.succeed({ sid: "SM1", attempts: 1 }),
              },
            },
          }),
        ],
      })
    ).toThrow(
      'Action "twilio/send-sms" cannot derive the fields the editor offers'
    );
  });

  // F3: the editor keys its renderer on `field.type` alone, so a template-picker
  // field type draws the picker whatever `literal` says, and the value it seeds
  // reaches the vendor unresolved. This is latent until an integration grows one.
  it("refuses a literal field whose type renders the template picker", () => {
    expect(() =>
      assembleExtensions({
        integrations: [
          defineIntegration({
            type: "twilio",
            label: "Twilio",
            description: "Sends messages",
            credentials: {},
            actions: {
              "send-sms": {
                label: "Send SMS",
                description: "Sends a message",
                input: Schema.Struct({ to: Schema.String }),
                output: Schema.Struct({
                  sid: Schema.String.annotate({ description: "Message SID" }),
                }),
                configFields: [
                  {
                    key: "to",
                    label: "To",
                    type: "template-input",
                    required: true,
                    literal: true,
                  },
                ],
                handler: sendSmsHandler,
              },
            },
          }),
        ],
      })
    ).toThrow('Action "twilio/send-sms" marks its "to" field literal');
  });

  it("accepts a literal field typed text, since it draws no template picker", () => {
    expect(() =>
      assembleExtensions({
        integrations: [
          defineIntegration({
            type: "twilio",
            label: "Twilio",
            description: "Sends messages",
            credentials: {},
            actions: {
              "send-sms": {
                label: "Send SMS",
                description: "Sends a message",
                input: Schema.Struct({ to: Schema.String }),
                output: Schema.Struct({
                  sid: Schema.String.annotate({ description: "Message SID" }),
                }),
                configFields: [
                  {
                    key: "to",
                    label: "To",
                    type: "text",
                    required: true,
                    literal: true,
                  },
                ],
                handler: sendSmsHandler,
              },
            },
          }),
        ],
      })
    ).not.toThrow();
  });

  it("keeps providers separate when type and provider names contain the former delimiter", () => {
    const firstProvider: ConfigOptionsProvider = {
      answers: "options",
      load: async () => async () => ({ status: "options", options: [] }),
    };
    const secondProvider: ConfigOptionsProvider = {
      answers: "fields",
      load: async () => async () => ({ status: "fields", fields: [] }),
    };
    const set = assembleExtensions({
      integrations: [
        { ...aDefinition("a"), configOptions: { "b::c": firstProvider } },
        { ...aDefinition("a::b"), configOptions: { c: secondProvider } },
      ],
    });

    expect(set.configOptionsFor("a", "b::c")).toBe(firstProvider);
    expect(set.configOptionsFor("a::b", "c")).toBe(secondProvider);
  });
});
