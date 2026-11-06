/**
 * The Inngest forwarder as Inngest invokes it, when the inbox write fails: one
 * log record that names the Event and nothing of its data, and a rejection
 * Inngest can show with the storage failure as its cause.
 */

import { InngestTestEngine } from "@inngest/test";
import { Effect } from "effect";
import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import {
  makeRecordingLogger,
  stubWfGraphRuntime,
} from "#src/backend/lib/effect/test-layers";
import { createInngestEventForwarder } from "#src/backend/lib/inngest/event-forwarder";
import { DriverError } from "#src/backend/services/executions/driver";

const client = new Inngest({ id: "event-forwarder-test", isDev: true });

/** A value the event carries that no log record or rejection may repeat. */
const SECRET = "4111-1111-1111-1111";

describe("the Inngest event forwarder", () => {
  it("logs one record and rejects with a sentence when the inbox write fails", async () => {
    const storageFailure = new Error("connection reset");
    const recorder = makeRecordingLogger();
    await using runtime = stubWfGraphRuntime({
      logger: recorder.layer,
      executionDriver: {
        receiveEvent: () =>
          Effect.fail(new DriverError({ cause: storageFailure })),
      },
    });
    const forwarder = createInngestEventForwarder({
      client,
      name: "app/appointment.created",
      runtime,
    });

    const { error } = await new InngestTestEngine({
      function: forwarder,
    }).execute({
      events: [
        {
          name: "app/appointment.created",
          id: "evt_1",
          data: { card: SECRET },
        },
      ],
    });

    expect(JSON.stringify(error)).toContain(
      "Could not record the Inngest event in the event inbox"
    );
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(recorder.lines).toEqual([
      {
        message: "Failed to record an Inngest event in the event inbox",
        properties: {
          event: { name: "app/appointment.created", keyed: true },
          error: storageFailure,
        },
      },
    ]);
  });
});
