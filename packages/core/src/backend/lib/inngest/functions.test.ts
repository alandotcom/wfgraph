import { Schema } from "effect";
import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";

import { defineEvent } from "#src/backend/extensions/define-event";
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

/**
 * What this app registers with Inngest: one listener per Event in the catalog.
 *
 * Nothing here reads a saved graph, which the stub runtime enforces -- its
 * workflow repository dies on every method, so a build that asked which
 * workflows exist would fail the test rather than pass with an empty list.
 */
describe("buildInngestFunctions", () => {
  it("builds a listener for each Event and no workflow function", async () => {
    const runtime = stubWfGraphRuntime({
      extensions: { events: [appointmentCreated] },
    });

    const functions = await buildInngestFunctions(client, runtime);

    expect(functions.map((fn) => fn.id())).toEqual([
      "wfgraph-event-app-appointment-created",
    ]);
  });
});
