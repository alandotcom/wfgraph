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

/** The `if` an Inngest function was registered with, read back off the options. */
function triggerFilters(built: unknown): (string | undefined)[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const { opts } = built as { opts: { triggers: { if?: string }[] } };
  return opts.triggers.map((trigger) => trigger.if);
}

/**
 * What this app registers with Inngest: the run function, the branch function,
 * and one listener per Event in the catalog.
 *
 * Nothing here reads a saved graph, which the stub runtime enforces -- its
 * workflow repository dies on every method, so a build that asked which
 * workflows exist would fail the test rather than pass with an empty list.
 */
describe("buildInngestFunctions", () => {
  it("builds the run and branch functions and a listener for each Event", async () => {
    const runtime = stubWfGraphRuntime({
      extensions: { events: [appointmentCreated] },
    });

    const functions = await buildInngestFunctions(client, runtime);

    expect(functions.map((fn) => fn.id())).toEqual([
      "workflow-run",
      "workflow-branch",
      "wfgraph-event-app-appointment-created",
    ]);
  });

  /**
   * The property the single run function buys: a workflow saved after the app
   * booted runs on the registration Inngest already has. An unfiltered trigger
   * is the whole of it -- every `workflow/run.requested` reaches this function,
   * whatever workflow it names.
   */
  it("gives the run function a trigger no workflow id narrows", async () => {
    const runtime = stubWfGraphRuntime();

    const [runFunction] = await buildInngestFunctions(client, runtime);

    expect(triggerFilters(runFunction)).toEqual([undefined]);
  });
});
