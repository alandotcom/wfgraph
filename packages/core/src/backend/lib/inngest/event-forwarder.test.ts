/**
 * The Inngest forwarder as Inngest invokes it: what it sends into the app's
 * `events`, and which failures Inngest retries.
 */

import { InngestTestEngine } from "@inngest/test";
import { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import {
  WfGraphEventRefused,
  type WfGraphEventInput,
  type WfGraphEvents,
} from "#src/backend/host-events";
import { createInngestEventForwarder } from "#src/backend/lib/inngest/event-forwarder";

const client = new Inngest({ id: "event-forwarder-test", isDev: true });

const NAME = "app/appointment.created";

/** An `events` whose `send` answers `answer` and records what it was handed. */
function recordingEvents(
  answer: () => Promise<{ id: string; duplicate: boolean }>
): {
  events: WfGraphEvents;
  sent: WfGraphEventInput[];
} {
  const sent: WfGraphEventInput[] = [];
  return {
    sent,
    events: {
      send: vi.fn(async (event: WfGraphEventInput) => {
        sent.push(event);
        return await answer();
      }),
    },
  };
}

async function forward(
  events: WfGraphEvents,
  event: { id: string; data: unknown }
) {
  const forwarder = createInngestEventForwarder({ client, name: NAME, events });
  return await new InngestTestEngine({ function: forwarder }).execute({
    events: [{ name: NAME, id: event.id, data: event.data as never }],
  });
}

describe("the Inngest event forwarder", () => {
  it("sends the event under its name, keyed by the Inngest event id, and answers the inbox receipt", async () => {
    const { events, sent } = recordingEvents(() =>
      Promise.resolve({ id: "inbox_1", duplicate: false })
    );

    const { result, error } = await forward(events, {
      id: "01JEVENT",
      data: { appointmentId: "appt_1" },
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ id: "inbox_1", duplicate: false });
    expect(sent).toEqual([
      { name: NAME, data: { appointmentId: "appt_1" }, id: "01JEVENT" },
    ]);
  });

  // Data with no fields is left for the Event's schema to refuse.
  it("sends data that is not a JSON object as an empty payload", async () => {
    const { events, sent } = recordingEvents(() =>
      Promise.resolve({ id: "inbox_1", duplicate: false })
    );

    await forward(events, { id: "01JEVENT", data: "not an object" });

    expect(sent.map((event) => event.data)).toEqual([{}]);
  });

  // The same event would be refused on every attempt.
  it("fails without a retry when the app refuses the send", async () => {
    const { events } = recordingEvents(() =>
      Promise.reject(
        new WfGraphEventRefused(
          'Payload refused for Event "app/appointment.created"'
        )
      )
    );

    const { error } = await forward(events, { id: "01JEVENT", data: {} });

    expect(error).toMatchObject({
      name: "NonRetriableError",
      message: 'Payload refused for Event "app/appointment.created"',
    });
  });

  it("rethrows a storage failure as it is, so Inngest retries the step", async () => {
    const storageFailure = new Error("Could not send this Event", {
      cause: new Error("connection reset"),
    });
    const { events } = recordingEvents(() => Promise.reject(storageFailure));

    const { error } = await forward(events, { id: "01JEVENT", data: {} });

    expect(error).toMatchObject({
      name: "Error",
      message: "Could not send this Event",
    });
  });
});
