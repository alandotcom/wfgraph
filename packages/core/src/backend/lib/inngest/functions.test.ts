import { Effect, Schema } from "effect";
import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";

import { defineEvent } from "#src/backend/extensions/define-event";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import {
  assembleExtensions,
  type WfGraphExtensions,
} from "#src/backend/extensions/extension-set";
import {
  createWfGraphInngestFunctions,
  type CreateWfGraphInngestFunctionsOptions,
} from "#src/backend/lib/inngest/functions";

// Constructing a client opens nothing; these functions are never invoked.
const client = new Inngest({ id: "functions-test", isDev: true });

/**
 * An app over `extensions`, assembled as `createWfGraphApp` assembles them,
 * whose `send` the build never calls.
 */
function appOver(
  extensions: WfGraphExtensions
): CreateWfGraphInngestFunctionsOptions["app"] {
  return {
    events: {
      send: () => Promise.reject(new Error("The build sends nothing")),
      sourceNames: assembleExtensions(extensions).hostEventSources,
    },
  };
}

const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  schema: Schema.Struct({
    id: Schema.String.annotate({ description: "Appointment ID" }),
  }),
  correlationPath: "id",
});

const billingPayload = Schema.Struct({
  type: Schema.String.annotate({ description: "Subtype" }),
});

/** Two Events on one umbrella source, told apart by `type`. */
const invoicePaid = defineEvent({
  name: "billing/invoice.paid",
  schema: billingPayload,
  source: { event: "billing/webhook", when: { path: "type", equals: "paid" } },
});
const invoiceVoided = defineEvent({
  name: "billing/invoice.voided",
  schema: billingPayload,
  source: {
    event: "billing/webhook",
    when: { path: "type", equals: "voided" },
  },
});

const acmeBooked = defineEvent({
  name: "acme/booked",
  schema: billingPayload,
  source: { event: "acme/webhook" },
});

/** An integration whose webhook raises its one Event. */
const acme = defineIntegration({
  type: "acme",
  label: "Acme",
  description: "Books appointments",
  credentials: {},
  actions: {},
  events: [acmeBooked],
  webhook: {
    source: "acme/webhook",
    verify: () => Effect.void,
    receive: () => undefined,
  },
});

type BuiltOptions = { opts: { triggers: { event: string; if?: string }[] } };

/** The triggers inngest kept for one built function. */
function triggersOf(fn: unknown): BuiltOptions["opts"]["triggers"] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (fn as BuiltOptions).opts.triggers;
}

describe("createWfGraphInngestFunctions", () => {
  it("builds one forwarder per host Event source and none for an integration's Event", () => {
    const functions = createWfGraphInngestFunctions({
      client,
      app: appOver({
        // A host may list an integration's Event too; the integration owns it.
        events: [appointmentCreated, invoicePaid, invoiceVoided, acmeBooked],
        integrations: [acme],
      }),
    });

    expect(functions.map((fn) => fn.id())).toEqual([
      "wfgraph-event-app-appointment-created",
      "wfgraph-event-billing-webhook",
    ]);
    // Each triggers on its name alone: the send tells an umbrella source's
    // Events apart by `when`, so Inngest filters nothing.
    expect(functions.map(triggersOf)).toEqual([
      [{ event: "app/appointment.created" }],
      [{ event: "billing/webhook" }],
    ]);
  });

  // The forwarder id is the name it receives slugged, so two names differing
  // only in punctuation are one function to Inngest: it would sync one and drop
  // the other.
  it("refuses two Events whose names slug to one forwarder id", () => {
    const twin = defineEvent({
      name: "app-appointment-created",
      schema: billingPayload,
    });
    expect(() =>
      createWfGraphInngestFunctions({
        client,
        app: appOver({ events: [appointmentCreated, twin] }),
      })
    ).toThrow("both name the Inngest function");
  });

  // Events on one umbrella source share its forwarder, so their own names never
  // become function ids.
  it("accepts Events on one source whose own names would slug to one id", () => {
    const created = defineEvent({
      name: "app/appointment.created",
      schema: Schema.Struct({ kind: Schema.String }),
      source: {
        event: "app/appointment",
        when: { path: "kind", equals: "created" },
      },
    });
    const twin = defineEvent({
      name: "app-appointment-created",
      schema: Schema.Struct({ kind: Schema.String }),
      source: {
        event: "app/appointment",
        when: { path: "kind", equals: "canceled" },
      },
    });

    expect(
      createWfGraphInngestFunctions({
        client,
        app: appOver({ events: [created, twin] }),
      }).map((fn) => fn.id())
    ).toEqual(["wfgraph-event-app-appointment"]);
  });
});
