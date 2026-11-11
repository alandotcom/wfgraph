/**
 * The end-to-end recipe docs/embedding.md gives a host for its CI, under
 * "Testing a host", written here against the public entries alone so the
 * documented code keeps running. Keep the two in step.
 */

import { expect, it } from "vitest";
import { z } from "zod";
import {
  createWfGraphApp,
  defineAction,
  defineEvent,
  trustWfGraphUpstream,
} from "#src/index";
import { wfSqlite } from "#src/sqlite";

const appointmentCreated = defineEvent({
  name: "app/appointment.created",
  label: "Appointment created",
  schema: z.object({ appointment: z.object({ id: z.string() }) }),
  correlationPath: "appointment.id",
});

const confirmed: string[] = [];
const confirmAppointment = defineAction({
  id: "appointments/confirm",
  label: "Confirm Appointment",
  description: "Records that an appointment was confirmed.",
  input: z.object({ appointmentId: z.string() }),
  handler: async ({ input, step }) => {
    await step.run("confirm", async () => {
      confirmed.push(input.appointmentId);
      return null;
    });
    return { appointmentId: input.appointmentId };
  },
});

it("runs a published workflow from an Event sent with app.events.send", async () => {
  await using app = await createWfGraphApp({
    auth: trustWfGraphUpstream(),
    persistence: wfSqlite(),
    extensions: {
      events: [appointmentCreated],
      actions: [confirmAppointment],
    },
  });
  const rest = async (method: string, path: string, body?: unknown) => {
    const response = await app.fetch(
      new Request(`http://localhost/api/rest${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? null : JSON.stringify(body),
      })
    );
    expect(response.ok).toBe(true);
    return await response.json();
  };

  // The Lifecycle Node starts a run on the Event, and its Started outlet
  // leads to the action, whose input reads the Event's payload.
  const graph = {
    attributes: {},
    options: { allowSelfLoops: false, multi: false, type: "directed" },
    nodes: [
      {
        key: "entry",
        attributes: {
          id: "entry",
          type: "lifecycle",
          position: { x: 0, y: 0 },
          data: {
            label: "Appointments",
            type: "lifecycle",
            config: {
              lifecycleRules: {
                startEvents: ["app/appointment.created"],
                cancelEvents: [],
                concurrency: "unlimited",
                allowManualStart: true,
              },
            },
          },
        },
      },
      {
        key: "confirm",
        attributes: {
          id: "confirm",
          type: "action",
          position: { x: 0, y: 160 },
          data: {
            label: "Confirm",
            type: "action",
            config: {
              actionType: "appointments/confirm",
              appointmentId: "{{@entry:Appointments.appointment.id}}",
            },
          },
        },
      },
    ],
    edges: [
      {
        key: "entry->confirm",
        source: "entry",
        target: "confirm",
        attributes: {
          id: "entry->confirm",
          source: "entry",
          target: "confirm",
          sourceHandle: "started",
        },
      },
    ],
  };

  const created = await rest("POST", "/workflows/create", {
    name: "Confirm appointments",
    graph,
  });
  await rest("POST", `/workflows/${created.id}/publish`, {
    graph,
    expectedDraftRevision: created.draftRevision,
    expectedPublishedVersionId: null,
  });

  await app.events.send(appointmentCreated, {
    appointment: { id: "appt_123" },
  });

  await expect
    .poll(
      async () =>
        (await rest("GET", `/workflows/${created.id}/executions`)).items[0]
          ?.status,
      { timeout: 10_000 }
    )
    .toBe("completed");
  expect(confirmed).toEqual(["appt_123"]);
});
