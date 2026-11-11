/**
 * An event-mode Wait that parks after an Event it waits for was delivered: the
 * park catches up on that arrival, and on no arrival the run itself owes
 * nothing to, driven pass by pass over the harness in `delivery-fixtures.ts`.
 */

import { expect, it } from "vitest";
import { Effect } from "effect";
import { serializeConditionModel } from "@wfgraph/shared/conditions/condition-schema";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { DeliveryHarness } from "#src/backend/executor/testing/delivery-fixtures";
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

/** Starts on `START_EVENT`, waits for `waitsFor` matching its appointment, then marks `after`. */
function waitsAfterStart(waitsFor: string) {
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode({
        lifecycleRules: {
          concurrency: "unlimited",
          startEvents: [START_EVENT],
          cancelEvents: [],
          allowManualStart: true,
        },
      }),
      waitNode("wait", {
        ...onEvent(waitsFor, "1h"),
        waitFor: [
          {
            event: waitsFor,
            match: serializeConditionModel({
              version: 2,
              groupLogic: "and",
              groups: [
                {
                  id: "group",
                  logic: "and",
                  conditions: [
                    {
                      id: "rule",
                      field: "appointmentId",
                      fieldType: "string",
                      operator: "equals",
                      value: "{{@entry:Appointments.appointmentId}}",
                    },
                  ],
                },
              ],
            }),
          },
        ],
      }),
      actionNode("after", "test/mark"),
    ],
    edges: [edge("entry", "wait", "started"), edge("wait", "after")],
  });
}

/** The node ids `executionId` is parked on. */
function parkedOn(harness: DeliveryHarness, executionId: string) {
  return harness.connection.run(
    Effect.flatMap(ExecutionRepo, (executions) =>
      executions
        .listWaitingStates(executionId)
        .pipe(Effect.map((waits) => waits.map((wait) => wait.nodeId)))
    )
  );
}

export function describeDeliveryCatchUpCases(
  open: () => Promise<DeliveryHarness>
): void {
  it("wakes a Wait at its park with an Event delivered after the run started and before the Wait parked", async () => {
    const harness = await open();
    await harness.publish("wf_waits", waitsAfterStart(CANCEL_EVENT));
    const start = await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_40" },
    });
    // The start's delivery opens the run, which no pass has run yet.
    await harness.passOnce();
    harness.advance(1);
    // Another appointment's Event, then this one's, both delivered before
    // the run reaches its Wait.
    await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_other" },
    });
    await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_40" },
    });
    await harness.passOnce();
    await harness.passOnce();
    await harness.drain();

    const run = await harness.runOf("wf_waits", start.inboxId);
    expect(harness.marks()).toEqual(["after"]);
    expect(run?.status).toBe("completed");
  });

  it("leaves a Wait parked when the Event it waits for arrived before the run started, or is the Event that started it", async () => {
    const harness = await open();
    await harness.publish("wf_before", waitsAfterStart(CANCEL_EVENT));
    await harness.publish("wf_own", waitsAfterStart(START_EVENT));
    await harness.send({
      name: CANCEL_EVENT,
      data: { appointmentId: "appt_41" },
    });
    await harness.drain();
    harness.advance(1);
    const start = await harness.send({
      name: START_EVENT,
      data: { appointmentId: "appt_41" },
    });
    await harness.drain();

    const before = await harness.runOf("wf_before", start.inboxId);
    const own = await harness.runOf("wf_own", start.inboxId);
    if (before === null || own === null) throw new Error("No run started");
    expect(harness.marks()).toEqual([]);
    expect(await parkedOn(harness, before.id)).toEqual(["wait"]);
    expect(await parkedOn(harness, own.id)).toEqual(["wait"]);
  });
}
