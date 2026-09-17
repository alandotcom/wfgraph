import { expect } from "vitest";
import * as fc from "fast-check";
import {
  lifecycle,
  record,
  edge,
  wait,
  START,
  CANCEL,
  WAKE,
} from "#src/backend/testing/reliability/fixtures";
import { eventually } from "#src/backend/testing/reliability/control";
import {
  waitForRegisteredWaits,
  expectSettledExecution,
  observeExecution,
} from "#src/backend/testing/reliability/assertions";
import { withGroupLayout } from "#src/backend/testing/reliability/groups";
import { groupLayoutProperty } from "#src/backend/testing/reliability/property";

// Started: work -> finish. Canceled: [optional Wait] -> cleanup.
// Deliver Cancel after finish runs but before completion is persisted.
// Cleanup must run once, including when its own durable writes need a retry.
// Each case also runs with one side's steps in a vertical and a horizontal Group,
// and must route, clean up and retry the same way.
type CleanupMode = "direct" | "event" | "delay";
type CancellationScenario = {
  cleanupMode: CleanupMode;
  failurePoint: "none" | "terminal-write" | "wait-settlement";
  cancelDeliveries: number;
  cancelMarker: string;
  groupedSide: "started" | "canceled";
};

const cancellationScenarios = fc
  .record({
    cleanupMode: fc.constantFrom<CleanupMode>("direct", "event", "delay"),
    failurePoint: fc.constantFrom<CancellationScenario["failurePoint"]>(
      "none",
      "terminal-write",
      "wait-settlement"
    ),
    cancelDeliveries: fc.integer({ min: 1, max: 3 }),
    cancelMarker: fc.string({ minLength: 1, maxLength: 12 }),
    groupedSide: fc.constantFrom<CancellationScenario["groupedSide"]>(
      "started",
      "canceled"
    ),
  })
  .map((value) => ({
    ...value,
    // Only event Waits settle a claimed wake signal; other modes exercise the terminal write.
    failurePoint:
      value.failurePoint === "wait-settlement" && value.cleanupMode !== "event"
        ? "terminal-write"
        : value.failurePoint,
    // A direct cleanup is one step, and a Group holds at least two.
    groupedSide: value.cleanupMode === "direct" ? "started" : value.groupedSide,
  }));
groupLayoutProperty(
  "late Cancel completes cleanup",
  cancellationScenarios,
  [
    {
      cleanupMode: "direct",
      failurePoint: "terminal-write",
      cancelDeliveries: 2,
      cancelMarker: "cancel",
      groupedSide: "started",
    },
    {
      cleanupMode: "event",
      failurePoint: "wait-settlement",
      cancelDeliveries: 2,
      cancelMarker: "cancel",
      groupedSide: "canceled",
    },
    {
      cleanupMode: "delay",
      failurePoint: "none",
      cancelDeliveries: 1,
      cancelMarker: "cancel",
      groupedSide: "canceled",
    },
  ] satisfies CancellationScenario[],
  async (host, scenario, layout) => {
    const workflowId = await host.publish(
      withGroupLayout(
        cancellationWorkflow(scenario.cleanupMode),
        scenario.groupedSide === "started"
          ? ["work", "finish"]
          : ["cleanup_wait", "cleanup"],
        layout
      )
    );

    // Hold the final completion write so Cancel can claim the Execution first.
    host.faults.completion.arm({ fail: false, hold: true });
    if (scenario.failurePoint === "terminal-write")
      host.faults.terminal.arm({ fail: true, hold: false });
    if (scenario.failurePoint === "wait-settlement")
      host.faults.settlement.arm({ fail: true, hold: false });
    await host.runtime.send(START, { entityId: "subject", marker: "start" });
    await eventually(
      "completion boundary",
      async () => host.faults.completion.hits,
      (count) => count === 1
    );
    const executions = await host.run(
      host.repo.listByWorkflow({ workflowId, includeSuperseded: true })
    );
    const executionId = executions[0]!.id;

    // Repeated deliveries share one event id. Wait until the Cancel claim is durable.
    const cancelDeliveryId = crypto.randomUUID();
    for (let index = 0; index < scenario.cancelDeliveries; index++)
      await host.runtime.send(
        CANCEL,
        { entityId: "subject", marker: scenario.cancelMarker },
        cancelDeliveryId
      );
    const claim = await eventually(
      "Cancel claim",
      () => host.run(host.repo.findTerminationState(executionId)),
      (state) => state?.claim?.kind === "cancel"
    );
    expect(claim?.claim).toMatchObject({
      kind: "cancel",
      payload: { marker: scenario.cancelMarker },
    });

    // Let completion observe the claim and route into the Canceled outlet.
    host.faults.completion.release();
    if (scenario.cleanupMode === "event") {
      // A real Inngest subscription must exist before the wake event is sent.
      await waitForRegisteredWaits(host, executionId, 1);
      await host.runtime.send(WAKE[0]!, {
        entityId: "subject",
        marker: "wake",
      });
    }

    // The Execution must finish canceled, with each Started action and one cleanup.
    await expectSettledExecution(host, workflowId, "canceled");
    expect(host.ledger).toEqual([
      { marker: "work" },
      { marker: "finish" },
      { marker: "cleanup" },
    ]);
    if (scenario.failurePoint === "terminal-write")
      expect(host.faults.terminal.hits).toBe(1);
    if (scenario.failurePoint === "wait-settlement")
      expect(host.faults.settlement.hits).toBe(1);
    return observeExecution(host, executionId);
  }
);

function cancellationWorkflow(cleanupMode: CleanupMode) {
  const withWait = cleanupMode !== "direct";
  return {
    nodes: [
      lifecycle(["before-execution"]),
      record("work"),
      record("finish"),
      ...(withWait
        ? [
            wait(
              "cleanup_wait",
              cleanupMode === "event" ? "event" : "delay",
              WAKE[0],
              "2s"
            ),
          ]
        : []),
      record("cleanup"),
    ],
    edges: [
      edge("entry", "work", "started"),
      edge("work", "finish"),
      edge("entry", withWait ? "cleanup_wait" : "cleanup", "canceled"),
      ...(withWait ? [edge("cleanup_wait", "cleanup")] : []),
    ],
  };
}
