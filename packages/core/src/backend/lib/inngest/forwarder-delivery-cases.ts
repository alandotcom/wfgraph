/**
 * Inngest events the forwarder sends into the event inbox, delivered by the
 * worker loop on one persistence backend: an event keyed by its Inngest id
 * and retried, and one on an umbrella source. A runner per backend calls
 * `describeForwarderDeliveryCases`, over the delivery harness the executor's
 * own delivery cases use.
 */

import { InngestTestEngine } from "@inngest/test";
import { Inngest } from "inngest";
import { describe, expect, it } from "vitest";
import { readJsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  type DeliveryHarness,
  endedRun,
  extensions,
  settled,
  startsAndSends,
  useDeliveryHarness,
  VENDOR_BOOKED,
  WEBHOOK_SOURCE,
} from "#src/backend/executor/testing/delivery-fixtures";
import { START_EVENT } from "#src/backend/executor/testing/run-fixtures";
import { createHostEvents } from "#src/backend/host-events";
import { createInngestEventForwarder } from "#src/backend/lib/inngest/event-forwarder";
import { usePersistenceRegistry } from "#src/backend/persistence/conformance/support";
import type { PersistenceConformanceHarness } from "#src/backend/persistence/persistence-conformance-test-support";

/** The Inngest client the forwarders are built on. Constructing one opens nothing. */
const inngestClient = new Inngest({ id: "forwarder-delivery", isDev: true });

/** What a forwarder's Inngest function answered, read back from the test engine. */
function forwardReceipt(result: unknown): { id: string; duplicate: boolean } {
  const receipt = readJsonObject(result);
  if (
    typeof receipt?.id !== "string" ||
    typeof receipt.duplicate !== "boolean"
  ) {
    throw new Error("The forwarder answered no inbox receipt");
  }
  return { id: receipt.id, duplicate: receipt.duplicate };
}

/**
 * Runs the Inngest forwarder for `name` on one Inngest event, as Inngest
 * invokes it, sending through the harness app's `events`, and answers the
 * receipt its step returned. Rejects with the function's error as `cause`
 * when the forward failed.
 */
async function forward(
  harness: DeliveryHarness,
  input: { name: string; event: { id?: string | undefined; data: unknown } }
): Promise<{ id: string; duplicate: boolean }> {
  const forwarder = createInngestEventForwarder({
    client: inngestClient,
    name: input.name,
    events: createHostEvents(harness.app, extensions),
  });
  const { result, error } = await new InngestTestEngine({
    function: forwarder,
  }).execute({
    events: [
      omitUndefined({
        name: input.name,
        id: input.event.id,
        data: readJsonObject(input.event.data) ?? {},
      }),
    ],
  });
  if (error !== undefined) {
    throw new Error("The forwarder failed", { cause: error });
  }
  return forwardReceipt(result);
}

export function describeForwarderDeliveryCases(
  backend: PersistenceConformanceHarness
): void {
  const title = `Inngest forwarder deliveries on ${backend.backend}`;
  if (backend.skip !== undefined) {
    describe.skip(`${title} (${backend.skip})`, () => {
      it("runs every forwarder delivery case", () => {
        // Skipped: there is no database to run them on.
      });
    });
    return;
  }
  describe(title, () => {
    const registry = usePersistenceRegistry(
      backend.createDatabase,
      backend.teardown
    );
    const open = useDeliveryHarness(registry.openDatabase);

    it("records an Inngest event the forwarder hands over as one inbox row keyed by its event id, answers a retried forward with that row, and delivers it to a run that completes", async () => {
      const harness = await open();
      await harness.publish("wf_start", startsAndSends(START_EVENT));
      const event = {
        id: "01JINNGESTEVENT",
        data: { appointmentId: "appt_forwarded" },
      };
      const first = await forward(harness, { name: START_EVENT, event });
      const retried = await forward(harness, { name: START_EVENT, event });
      const loop = harness.loop();

      const row = await settled(harness, first.id);
      const runId = await endedRun(harness, "wf_start");
      await loop.stop();

      expect(first.duplicate).toBe(false);
      expect(retried).toEqual({ id: first.id, duplicate: true });
      expect(row).toMatchObject({
        status: "delivered",
        name: START_EVENT,
        data: { appointmentId: "appt_forwarded" },
        connectionId: null,
        idempotencyKey: "01JINNGESTEVENT",
      });
      expect(await harness.runs("wf_start")).toEqual([
        { id: runId, status: "completed" },
      ]);
      expect(await harness.runOf("wf_start", first.id)).toMatchObject({
        id: runId,
      });
    });

    // An umbrella source's forwarder sends under the source name, and the send
    // tells which Event it is by `source.when`, recording it under that Event's
    // name. The send checks the payload, so data the Event refuses fails the
    // forward without a retry and never reaches the inbox.
    it("records an Inngest event forwarded under an umbrella source as the Event its data is, and refuses one whose data the Event refuses", async () => {
      const harness = await open();
      await harness.publish("wf_hook", startsAndSends(VENDOR_BOOKED));
      const booked = await forward(harness, {
        name: WEBHOOK_SOURCE,
        event: {
          id: "evt_booked",
          data: { type: "booked", appointmentId: "appt_umbrella" },
        },
      });
      const refused = forward(harness, {
        name: WEBHOOK_SOURCE,
        event: { id: "evt_refused", data: { type: "booked" } },
      });
      await expect(refused).rejects.toMatchObject({
        cause: { name: "NonRetriableError" },
      });
      const loop = harness.loop();

      const row = await settled(harness, booked.id);
      const runId = await endedRun(harness, "wf_hook");
      await loop.stop();

      expect(row).toMatchObject({ status: "delivered", name: VENDOR_BOOKED });
      expect(await harness.runs("wf_hook")).toEqual([
        { id: runId, status: "completed" },
      ]);
      expect(await harness.runOf("wf_hook", booked.id)).toMatchObject({
        id: runId,
      });
      // The refused event left no inbox row its key would answer with.
      const resent = await harness.sendEvent({
        name: WEBHOOK_SOURCE,
        data: { type: "booked", appointmentId: "appt_resent" },
        id: "evt_refused",
      });
      expect(resent.duplicate).toBe(false);
    });
  });
}
