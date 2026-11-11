/**
 * Event deliveries driven one pass at a time with `claimDue` and `leasedPass`
 * on a clock the case moves past a lease, as `pass-cases.ts` drives runs: a
 * refused payload, a lifecycle step that spends its retries, and a crash
 * between a step and its memo row, alone and under a Cancel claim, and a
 * failed delivery a resend of its key reopens.
 */

import { expect, it } from "vitest";
import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { recordingLogger } from "#src/backend/executor/testing/recorded-logger";
import {
  crashBeforeLifecycleMemo,
  type DeliveryHarness,
  holdsUntilCanceled,
  LEASE_MS,
  type PassOptions,
  startsAndSends,
} from "#src/backend/executor/testing/delivery-fixtures";
import {
  actionNode,
  CANCEL_EVENT,
  edge,
  lifecycleNode,
  onEvent,
  START_EVENT,
  waitNode,
} from "#src/backend/executor/testing/run-fixtures";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

export function describeDeliveryCrashCases(
  open: () => Promise<DeliveryHarness>
): void {
  it("marks a row whose payload its Event refuses failed with the reason, and never schedules it again", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const refused = await harness.send({
      name: START_EVENT,
      data: { appointment: "appt_5" },
    });
    const unknown = await harness.send({
      name: "app/never.declared",
      data: { appointmentId: "appt_5" },
    });

    const results = await harness.drain();
    const afterwards = await harness.connection.run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return {
          poll: yield* executions.scheduleUnscheduledInbox({
            now: harness.now(),
            limit: 10,
          }),
          claim: yield* executions.claimDue({
            lanes: [{ kind: "delivery", limit: 10 }],
            workerId: "worker_2",
            leaseMs: LEASE_MS,
            now: harness.now(),
          }),
        };
      })
    );

    expect(results).toEqual([
      {
        kind: "unavailable",
        reason: "payload_refused",
        ending: "written",
        severity: "warn",
        detail: expect.any(String),
      },
      {
        kind: "unavailable",
        reason: "unknown_event",
        ending: "written",
        severity: "warn",
        detail: expect.any(String),
      },
    ]);
    const refusedRow = await harness.inbox(refused.inboxId);
    expect(refusedRow).toMatchObject({ status: "failed" });
    expect(refusedRow?.status === "failed" && refusedRow.error).toMatch(
      new RegExp(`^Payload refused for Event "${START_EVENT}": `)
    );
    // The stored reason names what the schema expects and quotes nothing of
    // what arrived.
    expect(JSON.stringify(refusedRow)).not.toMatch(/appt_5.*appt_5/);
    expect(await harness.inbox(unknown.inboxId)).toMatchObject({
      status: "failed",
    });
    expect(afterwards).toEqual({ poll: [], claim: [] });
    expect(await harness.runs("wf_start")).toEqual([]);
  });

  it("marks a delivery failed once its lifecycle step spends its retries", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const sent = await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_6" },
    });
    // The workflow's own read fails on every attempt, so the lifecycle step
    // that makes it fails on every pass.
    let attempts = 0;
    const results = await harness.drain({
      wrapWorkflows: (workflows) => ({
        ...workflows,
        findByIdWithPublishedVersionForRun: () =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(
              new DatabaseError({ cause: new Error("connection reset") })
            );
          }),
      }),
    });

    expect(results.map((result) => result.kind)).toEqual([
      "retry",
      "retry",
      "retry",
      "retry",
      "ended",
    ]);
    expect(attempts).toBe(5);
    const row = await harness.inbox(sent.inboxId);
    expect(row).toMatchObject({ status: "failed" });
    expect(row?.status === "failed" && row.error).toMatch(
      /^Delivered to 0 of 1 workflows\. Failed on every retry: workflow wf_start \(Lifecycle Rules\): /
    );
    // The schedule row is kept settled with its memo for a resend.
    expect(
      await harness.connection.run(
        Effect.flatMap(ExecutionRepo, (executions) =>
          executions.findSchedule({ inboxId: sent.inboxId })
        )
      )
    ).toMatchObject({ state: "settled", ownerToken: null });
    expect(await harness.runs("wf_start")).toEqual([]);
    const refusals = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listWorkflowEvents({
          workflowId: "wf_start",
          eventType: "run_refused",
        })
      )
    );
    expect(refusals.map((refusal) => refusal.metadata)).toEqual([
      expect.objectContaining({
        reason: "delivery_failed",
        deliveryId: sent.inboxId,
      }),
    ]);
  });

  it("gives a workflow that still fails a full set of retries when a resend reopens its failed delivery", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const arrival = {
      name: START_EVENT,
      data: { appointmentId: "appt_31" },
      idempotencyKey: "vendor_31",
    };
    let attempts = 0;
    const failing: PassOptions = {
      wrapWorkflows: (workflows) => ({
        ...workflows,
        findByIdWithPublishedVersionForRun: () =>
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(
              new DatabaseError({ cause: new Error("connection reset") })
            );
          }),
      }),
    };
    const sent = await harness.send(arrival);
    const first = await harness.drain(failing);
    await harness.send(arrival);
    const second = await harness.drain(failing);

    const passes = ["retry", "retry", "retry", "retry", "ended"];
    expect(first.map((result) => result.kind)).toEqual(passes);
    expect(second.map((result) => result.kind)).toEqual(passes);
    expect(attempts).toBe(10);
    expect(await harness.inbox(sent.inboxId)).toMatchObject({
      status: "failed",
    });
  });

  // One workflow's Lifecycle Rules failing on every retry must not keep the
  // Event from another workflow whose run it cancels.
  it("cancels another workflow's run while one workflow's lifecycle step fails on every retry, and settles the row failed for that workflow alone", async () => {
    const harness = await open();
    await harness.publish("wf_cancel", holdsUntilCanceled);
    await harness.publish("wf_failing", startsAndSends(START_EVENT));
    await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_11" },
    });
    await harness.drain();
    const [parked] = await harness.runs("wf_cancel");
    if (parked === undefined) throw new Error("No run was started");

    const cancel = await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_11" },
    });
    await harness.drain({
      wrapWorkflows: (workflows) => ({
        ...workflows,
        findByIdWithPublishedVersionForRun: (workflowId) =>
          workflowId === "wf_failing"
            ? Effect.fail(
                new DatabaseError({ cause: new Error("connection reset") })
              )
            : workflows.findByIdWithPublishedVersionForRun(workflowId),
      }),
    });

    const termination = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.findTerminationState(parked.id)
      )
    );
    expect(termination?.claim).toMatchObject({
      kind: "cancel",
      eventName: CANCEL_EVENT,
    });
    const row = await harness.inbox(cancel.inboxId);
    expect(row?.status === "failed" && row.error).toMatch(
      /^Delivered to 1 of 2 workflows\. Failed on every retry: workflow wf_failing \(Lifecycle Rules\): /
    );
    const cancellations = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listWorkflowEvents({
          workflowId: "wf_failing",
          eventType: "cancel_not_delivered",
        })
      )
    );
    expect(cancellations).toHaveLength(1);
  });

  // A resend reopens a failed row. The workflows its first delivery reached
  // are answered from that delivery's memo, so a run it woke and that has
  // parked again on the same Event is left for the next arrival.
  it("answers the workflows a failed delivery reached from its memo when a resend reopens it, and wakes no Wait a second time", async () => {
    const harness = await open();
    await harness.publish(
      "wf_waits",
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode({
            lifecycleRules: {
              concurrency: "unlimited",
              startEvents: [START_EVENT],
              cancelEvents: [],
              allowManualStart: true,
            },
          }),
          waitNode("first", onEvent(CANCEL_EVENT, "1h")),
          waitNode("second", onEvent(CANCEL_EVENT, "1h")),
          actionNode("after", "test/mark"),
        ],
        edges: [
          edge("entry", "first", "started"),
          edge("first", "second"),
          edge("second", "after"),
        ],
      })
    );
    await harness.publish(
      "wf_failing",
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode({
            lifecycleRules: {
              concurrency: "unlimited",
              startEvents: [CANCEL_EVENT],
              cancelEvents: [],
              allowManualStart: true,
            },
          }),
          actionNode("send", "test/send"),
        ],
        edges: [edge("entry", "send", "started")],
      })
    );
    await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_30" },
    });
    await harness.drain();
    const [parked] = await harness.runs("wf_waits");
    if (parked === undefined) throw new Error("No run was started");

    const arrival = {
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_30" },
      idempotencyKey: "vendor_30",
    };
    const first = await harness.send(arrival);
    await harness.drain({
      wrapWorkflows: (workflows) => ({
        ...workflows,
        findByIdWithPublishedVersionForRun: (workflowId) =>
          workflowId === "wf_failing"
            ? Effect.fail(
                new DatabaseError({ cause: new Error("connection reset") })
              )
            : workflows.findByIdWithPublishedVersionForRun(workflowId),
      }),
    });
    const failedRow = await harness.inbox(first.inboxId);
    const waitingAfterFailure = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listWaitingStates(parked.id)
      )
    );

    const resent = await harness.send(arrival);
    await harness.drain();

    expect(failedRow).toMatchObject({ status: "failed" });
    expect(waitingAfterFailure.map((wait) => wait.nodeId)).toEqual(["second"]);
    expect(resent).toMatchObject({ inboxId: first.inboxId, duplicate: false });
    expect(await harness.inbox(first.inboxId)).toMatchObject({
      status: "delivered",
    });
    // The workflow whose lifecycle step failed receives the Event now.
    expect(await harness.runs("wf_failing")).toHaveLength(1);
    // The run the first delivery woke stays parked on its second Wait.
    expect(harness.marks()).toEqual([]);
    const waiting = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listWaitingStates(parked.id)
      )
    );
    expect(waiting.map((wait) => wait.nodeId)).toEqual(["second"]);
  });

  it("writes one record for a delivery once its inbox row has settled, with the pass's fields and what the delivery came to", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const sent = await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_record" },
    });
    const recording = recordingLogger();

    // The settling write leaves a mark among the lines, so the case can tell
    // which came first.
    const result = await harness.passOnce({
      logger: recording.layer,
      wrap: (repo) => ({
        ...repo,
        finishDelivery: (input) =>
          repo
            .finishDelivery(input)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  recording.lines.push({ message: "settled", annotations: {} })
                )
              )
            ),
      }),
    });

    expect(result).toEqual({ kind: "ended" });
    const messages = recording.lines.map((line) => line.message);
    const record = recording.lines.filter(
      (line) => line.message === "Delivered an event"
    );
    expect(record).toHaveLength(1);
    expect(messages.indexOf("settled")).toBeLessThan(
      messages.indexOf("Delivered an event")
    );
    expect(record[0]?.annotations).toMatchObject({
      delivery: { inbox: sent.inboxId },
      pass: { worker: "worker_1", attempt: 0 },
      event: { name: START_EVENT },
      outcome: { workflows: 1, started: 1, canceled: 0, resumedWaits: 0 },
    });
  });

  it("re-runs a lifecycle step whose memo row a crash lost without opening a second run", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    const sent = await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_7" },
    });

    const crashed = await harness.passOnce({
      wrap: crashBeforeLifecycleMemo(),
    });
    // The start committed, and the delivery's row stays leased to the worker
    // that died until its lease runs out.
    const afterCrash = await harness.runs("wf_start");
    harness.advance(LEASE_MS + 1);
    await harness.drain();

    expect(crashed).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(afterCrash).toHaveLength(1);
    expect(await harness.runs("wf_start")).toEqual([
      { id: afterCrash[0]?.id, status: "completed" },
    ]);
    expect(await harness.runOf("wf_start", sent.inboxId)).toMatchObject({
      id: afterCrash[0]?.id,
    });
    expect(await harness.inbox(sent.inboxId)).toMatchObject({
      status: "delivered",
    });
  });

  it("records a Cancel that reached no run once across a crash between its lifecycle step and its memo row", async () => {
    const harness = await open();
    await harness.publish("wf_start", startsAndSends(START_EVENT));
    // A blank Entity Value is no Entity Value, so the Cancel reaches no run.
    const sent = await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: " " },
    });

    const crashed = await harness.passOnce({
      wrap: crashBeforeLifecycleMemo(),
    });
    harness.advance(LEASE_MS + 1);
    await harness.drain();

    expect(crashed).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(await harness.inbox(sent.inboxId)).toMatchObject({
      status: "delivered",
    });
    const cancellations = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listWorkflowEvents({
          workflowId: "wf_start",
          eventType: "cancel_not_delivered",
        })
      )
    );
    expect(cancellations.map((row) => row.metadata)).toEqual([
      expect.objectContaining({
        reason: "entity_value_missing",
        deliveryId: sent.inboxId,
      }),
    ]);
  });

  // The Canceled outlet parks a Wait on the very Event that claimed the run.
  // A delivery re-run after a crash between its claim and its memo row still
  // names the run it claimed, so that Wait is left for the next arrival.
  it("cancels a parked run once across a crash between the Cancel claim and its memo row, and leaves its Canceled-side Wait to the next arrival", async () => {
    const harness = await open();
    await harness.publish("wf_cancel", holdsUntilCanceled);
    await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_8" },
    });
    await harness.drain();
    const [parked] = await harness.runs("wf_cancel");
    if (parked === undefined) throw new Error("No run was started");

    const firstCancel = await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_8" },
    });
    const crashed = await harness.passOnce({
      wrap: crashBeforeLifecycleMemo(),
    });
    // The claimed run routes its Canceled outlet and parks on the Cancel
    // Event while the delivery's row is still leased to the worker that died.
    await harness.drain();
    const outletParked = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listWaitingStates(parked.id)
      )
    );
    harness.advance(LEASE_MS + 1);
    await harness.drain();

    const afterRetry = await harness.connection.run(
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        return {
          waiting: yield* executions.listWaitingStates(parked.id),
          events: yield* executions.listEvents(parked.id),
          termination: yield* executions.findTerminationState(parked.id),
        };
      })
    );

    expect(crashed).toEqual({ kind: "fence_refused", fence: "owner" });
    expect(outletParked.map((wait) => wait.nodeId)).toEqual(["canceled_wait"]);
    expect(await harness.inbox(firstCancel.inboxId)).toMatchObject({
      status: "delivered",
    });
    // The re-run delivery found its own claim and woke nothing in the run.
    expect(afterRetry.waiting.map((wait) => wait.nodeId)).toEqual([
      "canceled_wait",
    ]);
    expect(afterRetry.termination?.claim).toMatchObject({
      kind: "cancel",
      eventName: CANCEL_EVENT,
    });
    expect(
      afterRetry.events.filter(
        (event) => event.eventType === "run_cancel_requested"
      )
    ).toHaveLength(1);
    expect(harness.marks()).toEqual([]);

    // A second arrival of the Cancel Event claims nothing, and wakes the Wait.
    await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_8" },
    });
    await harness.drain();

    expect(harness.marks()).toEqual(["outlet"]);
    expect(await harness.runs("wf_cancel")).toEqual([
      { id: parked.id, status: "canceled" },
    ]);
    const finalEvents = await harness.connection.run(
      Effect.flatMap(ExecutionRepo, (executions) =>
        executions.listEvents(parked.id)
      )
    );
    expect(
      finalEvents.filter((event) => event.eventType === "run_cancel_requested")
    ).toHaveLength(1);
  });
}
