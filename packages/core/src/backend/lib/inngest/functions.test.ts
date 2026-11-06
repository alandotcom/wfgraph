import { Effect, Schema } from "effect";
import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";

import { defineEvent } from "#src/backend/extensions/define-event";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { buildInngestFunctions } from "#src/backend/lib/inngest/functions";

// Constructing a client opens nothing; these functions are never invoked.
const client = new Inngest({ id: "functions-test", isDev: true });

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

/** An integration whose webhook raises its one Event. */
const acme = defineIntegration({
  type: "acme",
  label: "Acme",
  description: "Books appointments",
  credentials: {},
  actions: {},
  events: [
    defineEvent({
      name: "acme/booked",
      schema: billingPayload,
      source: { event: "acme/webhook" },
    }),
  ],
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

/**
 * What this app registers with Inngest: one forwarder per name a host Event
 * arrives under.
 *
 * Nothing here reads a saved graph, which the stub runtime enforces -- its
 * workflow repository dies on every method, so a build that asked which
 * workflows exist would fail the test rather than pass with an empty list.
 */
describe("buildInngestFunctions", () => {
  it("builds one forwarder per host Event source and none for an integration's Event", async () => {
    const runtime = stubWfGraphRuntime({
      extensions: assembleExtensions({
        events: [appointmentCreated, invoicePaid, invoiceVoided],
        integrations: [acme],
      }),
    });

    const functions = await buildInngestFunctions(client, runtime);

    expect(functions.map((fn) => fn.id())).toEqual([
      "wfgraph-event-app-appointment-created",
      "wfgraph-event-billing-webhook",
    ]);
    // Each triggers on its name alone: the delivery body evaluates an
    // umbrella source's `when`, so Inngest filters nothing.
    expect(functions.map(triggersOf)).toEqual([
      [{ event: "app/appointment.created" }],
      [{ event: "billing/webhook" }],
    ]);
  });
});
