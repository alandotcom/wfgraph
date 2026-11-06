/**
 * Event deliveries through the worker loop, on the wall clock: an inbox row
 * delivered to a run that completes, a duplicate send, a host send through
 * `sendEvent`, an Inngest event the forwarder sends, alone and on an
 * umbrella source, webhook intake through two Connections, a row a host
 * inserted itself, and a webhook source told apart by its `source.when`
 * filter. Each case waits for the database to reach a state.
 */

import { expect, it } from "vitest";
import { Effect } from "effect";
import {
  ACME_BOOKED,
  ACME_WEBHOOK,
  type DeliveryHarness,
  endedRun,
  settled,
  startsAndSends,
  VENDOR_BOOKED,
  WEBHOOK_SOURCE,
} from "#src/backend/executor/testing/delivery-fixtures";
import { START_EVENT } from "#src/backend/executor/testing/run-fixtures";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

export function describeDeliveryLoopCases(
  open: () => Promise<DeliveryHarness>
): void {
  it("delivers an inbox row through the worker loop, opening a run that completes", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const sent = await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_1" },
    });
    const loop = harness.loop();

    const row = await settled(harness, sent.inboxId);
    const runId = await endedRun(harness, "wf_start");
    await loop.stop();

    expect(row).toMatchObject({ status: "delivered" });
    expect(await harness.runs("wf_start")).toEqual([
      { id: runId, status: "completed" },
    ]);
    expect(await harness.runOf("wf_start", sent.inboxId)).toEqual({
      id: runId,
      status: "completed",
    });
    // The delivery's schedule row and memo went with its settling write.
    const left = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        Effect.all({
          schedule: executions.findSchedule({ inboxId: sent.inboxId }),
          memo: executions.listStepMemo({ inboxId: sent.inboxId }),
        })
      )
    );
    expect(left).toEqual({ schedule: null, memo: [] });
  });

  it("delivers a send repeated with the same idempotency key once", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const arrival = {
      name: START_EVENT,
      data: { appointmentId: "appt_2" },
      idempotencyKey: "booking_2",
    };
    const first = await harness.send(arrival);
    const second = await harness.send(arrival);
    const loop = harness.loop();

    await settled(harness, first.inboxId);
    await endedRun(harness, "wf_start");
    await loop.stop();

    expect(second).toEqual({ duplicate: true, inboxId: first.inboxId });
    expect(await harness.runs("wf_start")).toHaveLength(1);
  });

  it("records a host send through sendEvent, delivers it to a run that completes, and answers a repeated id with the first row", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const send = {
      name: START_EVENT,
      data: { appointmentId: "appt_sent" },
      id: "booking_sent",
    };
    const first = await harness.sendEvent(send);
    const again = await harness.sendEvent(send);
    const loop = harness.loop();

    const row = await settled(harness, first.id);
    const runId = await endedRun(harness, "wf_start");
    await loop.stop();

    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ id: first.id, duplicate: true });
    expect(row).toMatchObject({
      status: "delivered",
      name: START_EVENT,
      data: { appointmentId: "appt_sent" },
      connectionId: null,
      idempotencyKey: "booking_sent",
    });
    expect(await harness.runs("wf_start")).toEqual([
      { id: runId, status: "completed" },
    ]);
    expect(await harness.runOf("wf_start", first.id)).toMatchObject({
      id: runId,
    });
  });

  it("records an Inngest event the forwarder hands over as one inbox row keyed by its event id, answers a retried forward with that row, and delivers it to a run that completes", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const event = {
      id: "01JINNGESTEVENT",
      data: { appointmentId: "appt_forwarded" },
    };
    const first = await harness.forward({ name: START_EVENT, event });
    const retried = await harness.forward({ name: START_EVENT, event });
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
    const booked = await harness.forward({
      name: WEBHOOK_SOURCE,
      event: {
        id: "evt_booked",
        data: { type: "booked", appointmentId: "appt_umbrella" },
      },
    });
    const refused = harness.forward({
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

  it("records one inbox row per vendor id per Connection from webhook intake, and delivers each with its Connection", async () => {
    const harness = await open();
    const bound = await harness.addConnection("Acme bound");
    const other = await harness.addConnection("Acme other");
    // The workflow starts only on bookings that arrive through `bound`.
    await harness.publish(
      "wf_acme",
      startsAndSends(ACME_BOOKED, { [ACME_BOOKED]: bound })
    );
    const envelope = { appointmentId: "appt_hook" };
    const fromBound = await harness.webhook({
      connectionId: bound,
      vendorId: "msg_1",
      data: envelope,
    });
    const retried = await harness.webhook({
      connectionId: bound,
      vendorId: "msg_1",
      data: envelope,
    });
    // The vendor delivered the same message to a second Connection.
    const fromOther = await harness.webhook({
      connectionId: other,
      vendorId: "msg_1",
      data: envelope,
    });
    const loop = harness.loop();

    const boundRow = await settled(harness, fromBound.inboxId);
    const otherRow = await settled(harness, fromOther.inboxId);
    const runId = await endedRun(harness, "wf_acme");
    await loop.stop();

    expect(fromBound.duplicate).toBe(false);
    expect(retried).toEqual({ inboxId: fromBound.inboxId, duplicate: true });
    expect(fromOther.duplicate).toBe(false);
    expect(fromOther.inboxId).not.toBe(fromBound.inboxId);
    // The row keeps the vendor's envelope as sent, and the Connection in its
    // own column.
    expect(boundRow).toMatchObject({
      status: "delivered",
      name: ACME_WEBHOOK,
      data: envelope,
      connectionId: bound,
      idempotencyKey: "msg_1",
    });
    expect(otherRow).toMatchObject({
      status: "delivered",
      connectionId: other,
    });
    expect(await harness.runs("wf_acme")).toEqual([
      { id: runId, status: "completed" },
    ]);
    expect(await harness.runOf("wf_acme", fromBound.inboxId)).toMatchObject({
      id: runId,
    });
    expect(await harness.runOf("wf_acme", fromOther.inboxId)).toBeNull();
    const run = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.findSummaryById(runId)
      )
    );
    expect(run?.startEventName).toBe(ACME_BOOKED);
  });

  it("picks up a row a host inserted in its own transaction on the loop's poll", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    await harness.database.execute(
      `insert into workflow_event_inbox (id, name, data, idempotency_key, connection_id) values ('host_1', '${START_EVENT}', '{"appointmentId":"appt_3"}', null, null)`
    );
    const loop = harness.loop();

    const row = await settled(harness, "host_1");
    await endedRun(harness, "wf_start");
    await loop.stop();

    expect(row).toMatchObject({ status: "delivered" });
    expect(await harness.runs("wf_start")).toHaveLength(1);
    expect(await harness.runOf("wf_start", "host_1")).toMatchObject({
      status: "completed",
    });
  });

  it("delivers a row named after a webhook source as the Event whose source filter its data satisfies, and settles one no Event on the source accepts", async () => {
    const harness = await open();
    await harness.publish("wf_hook", startsAndSends(VENDOR_BOOKED));
    const booked = await harness.send({
      name: WEBHOOK_SOURCE,
      data: { type: "booked", appointmentId: "appt_4" },
    });
    const unknownType = await harness.send({
      name: WEBHOOK_SOURCE,
      data: { type: "rescheduled", appointmentId: "appt_4" },
    });
    const loop = harness.loop();

    await settled(harness, booked.inboxId);
    const unmatched = await settled(harness, unknownType.inboxId);
    const runId = await endedRun(harness, "wf_hook");
    await loop.stop();

    expect(unmatched).toMatchObject({ status: "delivered" });
    expect(await harness.runs("wf_hook")).toEqual([
      { id: runId, status: "completed" },
    ]);
    expect(await harness.runOf("wf_hook", booked.inboxId)).toMatchObject({
      id: runId,
    });
    const run = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.findSummaryById(runId)
      )
    );
    expect(run?.startEventName).toBe(VENDOR_BOOKED);
  });
}
