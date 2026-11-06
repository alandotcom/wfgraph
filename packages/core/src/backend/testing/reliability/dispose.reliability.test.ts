import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import * as fc from "fast-check";
import {
  lifecycle,
  record,
  edge,
  START,
} from "#src/backend/testing/reliability/fixtures";
import { eventually } from "#src/backend/testing/reliability/control";
import { expectSettledExecution } from "#src/backend/testing/reliability/assertions";
import { reliabilityProperty } from "#src/backend/testing/reliability/property";

/**
 * How long `app.dispose()` may take once no pass of the worker loop is
 * running. A healthy dispose takes milliseconds. The loop's own drain bound is
 * ten seconds, so a dispose that waits it out fails this budget.
 */
const DISPOSE_BUDGET_MS = 5_000;

/** How long a dispose must stay open while the loop drains a held pass. */
const DRAIN_OBSERVATION_MS = 500;

// A prefix action followed by two actions that run in parallel, either as the
// two branches of a fan-out or as the two arms of a join. Disposing the app
// stops the worker loop and waits for the passes it is running.
// - `idle`: the Execution has completed, so no pass is running, and dispose
//   must settle within the budget.
// - `draining`: the pass is held inside its terminal write after every action
//   ran. Dispose must stay open while that pass drains, and settle within the
//   budget once the write is let through.
const disposeScenarios = fc.record({
  shape: fc.constantFrom("fanout", "join"),
  loop: fc.constantFrom("idle", "draining"),
});
type DisposeScenario = {
  shape: "fanout" | "join";
  loop: "idle" | "draining";
};
reliabilityProperty<DisposeScenario>(
  "App dispose settles after parallel action steps",
  disposeScenarios,
  [
    { shape: "fanout", loop: "idle" },
    { shape: "join", loop: "idle" },
    { shape: "join", loop: "draining" },
  ],
  async (host, scenario) => {
    const workflowId = await host.publish(parallelWorkflow(scenario.shape));
    const expectedMarkers =
      scenario.shape === "fanout"
        ? ["left", "prefix", "right"]
        : ["join", "left", "prefix", "right"];

    if (scenario.loop === "draining")
      host.faults.completion.arm({ fail: false, hold: true });
    await host.send(START, { entityId: "subject", marker: "start" });

    if (scenario.loop === "idle") {
      await expectSettledExecution(host, workflowId, "completed");
      expect(host.ledger.map((entry) => entry.marker).sort()).toEqual(
        expectedMarkers
      );
      const disposed = await Promise.race([
        host.dispose().then(() => true),
        delay(DISPOSE_BUDGET_MS).then(() => false),
      ]);
      expect(disposed).toBe(true);
      return;
    }

    await eventually(
      "pass held at its terminal write",
      async () => host.faults.completion.hits,
      (count) => count === 1
    );
    expect(host.ledger.map((entry) => entry.marker).sort()).toEqual(
      expectedMarkers
    );
    let settled = false;
    const disposal = host.dispose().then(() => {
      settled = true;
    });
    await delay(DRAIN_OBSERVATION_MS);
    expect(settled, "dispose returned before the loop drained its pass").toBe(
      false
    );
    host.faults.completion.release();
    const disposed = await Promise.race([
      disposal.then(() => true),
      delay(DISPOSE_BUDGET_MS).then(() => false),
    ]);
    expect(disposed).toBe(true);
    // Each action ran once, and the drained pass ran none again.
    expect(host.ledger.map((entry) => entry.marker).sort()).toEqual(
      expectedMarkers
    );
  }
);

function parallelWorkflow(shape: "fanout" | "join") {
  const arms = {
    nodes: [
      lifecycle(["before-execution"]),
      record("prefix"),
      record("left"),
      record("right"),
    ],
    edges: [
      edge("entry", "prefix", "started"),
      edge("prefix", "left"),
      edge("prefix", "right"),
    ],
  };
  if (shape === "fanout") return arms;
  return {
    nodes: [...arms.nodes, record("join")],
    edges: [...arms.edges, edge("left", "join"), edge("right", "join")],
  };
}
