/**
 * `createWfGraphApp`'s Event intake: the `events` options it refuses, a send
 * after dispose, and a run opened from `app.events.send` and from
 * `POST /api/events` on native SQLite.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { defineAction, defineEvent, WfGraphEventRefused } from "#src/index";
import { createWfGraphApp } from "#src/app";
import { createWfGraphRunner } from "#src/runner";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import {
  actionNode,
  edge,
  lifecycleNode,
  publishWorkflow,
} from "#src/backend/executor/testing/run-fixtures";
import { waitUntil } from "#src/backend/executor/testing/waiting";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { catalogFingerprint } from "#src/backend/services/workflows/version-digest";
import { createIntegrationCipher } from "#src/backend/services/integrations/cipher";
import { wfSqlite } from "#src/backend/persistence/sqlite";
import { BASE_OPTIONS } from "#src/app-test-support";

describe("createWfGraphApp events", () => {
  const EVENTS_KEY = "events-key-0123456789";
  const appointmentCreated = defineEvent({
    name: "app/appointment.created",
    schema: Schema.Struct({ appointmentId: Schema.String }),
    correlationPath: "appointmentId",
  });
  const sendAction = defineAction({
    id: "test/send",
    label: "Send",
    description: "Runs one durable step",
    input: Schema.Struct({}),
    handler: async ({ step }) => {
      await step.run("dispatch", () => Promise.resolve(null));
      return {};
    },
  });
  const extensions = {
    events: [appointmentCreated],
    actions: [sendAction],
  };

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "wfgraph-events-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a blank events.key", async () => {
    await expect(
      createWfGraphApp({ ...BASE_OPTIONS, events: { key: "  " } })
    ).rejects.toThrow("events.key is blank");
  });

  // A send the runtime cannot run any more is a failure the host can catch
  // like any storage failure: an Error with a sentence and the reason as cause.
  it("rejects a send after dispose with an Error carrying the cause", async () => {
    const app = await createWfGraphApp({
      ...BASE_OPTIONS,
      persistence: wfSqlite({ filename: join(dir, "disposed.sqlite") }),
      extensions,
    });
    await app.dispose();

    const rejection: unknown = await app.events
      .send({ name: appointmentCreated.name, data: { appointmentId: "a" } })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection).not.toBeInstanceOf(WfGraphEventRefused);
    expect(rejection).toMatchObject({ message: "Could not send this Event" });
    expect(rejection instanceof Error && rejection.cause).toBeDefined();
  });

  it("refuses an events.key holding whitespace, which no Bearer header could carry", async () => {
    await expect(
      createWfGraphApp({ ...BASE_OPTIONS, events: { key: "events key" } })
    ).rejects.toThrow("events.key contains whitespace");
  });

  /** One hour and 100 years, the bounds of a retention window, in milliseconds. */
  const HOUR_MS = 60 * 60 * 1000;
  const CENTURY_MS = 36_525 * 24 * HOUR_MS;

  it("refuses an events.retentionMs the sweep could not use, and so does createWfGraphRunner", async () => {
    for (const retentionMs of [0, -1, 1.5, Number.NaN, CENTURY_MS + 1]) {
      // eslint-disable-next-line eslint/no-await-in-loop -- one refusal per value
      await expect(
        createWfGraphApp({ ...BASE_OPTIONS, events: { retentionMs } })
      ).rejects.toThrow(
        "createWfGraphApp's events.retentionMs must be a positive integer of milliseconds, at most 100 years."
      );
    }
    await expect(
      createWfGraphRunner({
        persistence: wfSqlite(),
        encryption: BASE_OPTIONS.encryption,
        events: { retentionMs: 0 },
      })
    ).rejects.toThrow(
      "createWfGraphRunner's events.retentionMs must be a positive integer"
    );
  });

  it("refuses a runs.retentionMs outside one hour to 100 years, and so does createWfGraphRunner", async () => {
    for (const retentionMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      HOUR_MS - 1,
      CENTURY_MS + 1,
    ]) {
      // eslint-disable-next-line eslint/no-await-in-loop -- one refusal per value
      await expect(
        createWfGraphApp({ ...BASE_OPTIONS, runs: { retentionMs } })
      ).rejects.toThrow(
        "createWfGraphApp's runs.retentionMs must be an integer of milliseconds from one hour to 100 years."
      );
    }
    await expect(
      createWfGraphRunner({
        persistence: wfSqlite(),
        encryption: BASE_OPTIONS.encryption,
        runs: { retentionMs: 0 },
      })
    ).rejects.toThrow(
      "createWfGraphRunner's runs.retentionMs must be an integer of milliseconds from one hour to 100 years."
    );
  });

  // The repositories keep a run while its inbox row exists, so a run window
  // shorter than the inbox window is a valid setting.
  it("starts with a run window of one hour under the seven-day inbox window, and with both at 100 years", async () => {
    for (const options of [
      { runs: { retentionMs: HOUR_MS } },
      {
        events: { retentionMs: CENTURY_MS },
        runs: { retentionMs: CENTURY_MS },
      },
    ]) {
      // eslint-disable-next-line eslint/no-await-in-loop -- one app per setting
      const app = await createWfGraphApp({
        ...BASE_OPTIONS,
        persistence: wfSqlite(),
        ...options,
      });
      // eslint-disable-next-line eslint/no-await-in-loop -- one app per setting
      await app.dispose();
    }
  });

  it("opens a run that completes from app.events.send and from POST /api/events", async () => {
    const filename = join(dir, "wfgraph.sqlite");
    // A connection of the case's own publishes the workflow before the app
    // opens and reads the runs back while it runs.
    const instance = await wfSqlite({ filename }).open(
      createIntegrationCipher(BASE_OPTIONS.encryption)
    );
    const seed = ManagedRuntime.make(instance.repositories);
    try {
      await seed.runPromise(
        publishWorkflow({
          workflowId: "wf_events",
          versionId: "ver_events",
          graph: createSerializedWorkflowGraph({
            nodes: [
              lifecycleNode({
                lifecycleRules: {
                  concurrency: "unlimited",
                  startEvents: [appointmentCreated.name],
                  cancelEvents: [],
                  allowManualStart: true,
                },
              }),
              actionNode("send", "test/send"),
            ],
            edges: [edge("entry", "send", "started")],
          }),
          catalogFingerprint: catalogFingerprint(
            assembleExtensions(extensions).catalog
          ),
          subscribe: true,
        })
      );
      const runOf = (deliveryId: string) =>
        seed.runPromise(
          Effect.flatMap(ExecutionRepo, (executions) =>
            executions.findByDelivery({ workflowId: "wf_events", deliveryId })
          )
        );
      const completed = (deliveryId: string) =>
        waitUntil(
          async () => (await runOf(deliveryId))?.status === "completed",
          `No completed run for ${deliveryId}`
        );

      await using app = await createWfGraphApp({
        ...BASE_OPTIONS,
        persistence: wfSqlite({ filename }),
        extensions,
        events: { key: EVENTS_KEY },
      });

      const sent = await app.events.send({
        name: appointmentCreated.name,
        data: { appointmentId: "appt_in_process" },
      });
      const posted = await app.fetch(
        new Request("http://localhost/api/events", {
          method: "POST",
          headers: {
            authorization: `Bearer ${EVENTS_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: appointmentCreated.name,
            data: { appointmentId: "appt_over_http" },
            id: "booking_http",
          }),
        })
      );
      expect(posted.status).toBe(202);
      const receipt = readJsonObject(await posted.json());
      expect(receipt).toEqual({ id: expect.any(String), duplicate: false });
      const postedId = String(receipt?.id);

      await completed(sent.id);
      await completed(postedId);
      expect(sent.duplicate).toBe(false);
      await expect(
        app.events.send({ name: "app/never.declared", data: {} })
      ).rejects.toThrow(WfGraphEventRefused);
    } finally {
      await seed.dispose();
      await instance.close();
    }
  });
});
