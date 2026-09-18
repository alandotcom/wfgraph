import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import * as fc from "fast-check";
import {
  lifecycle,
  record,
  edge,
  START,
} from "#src/backend/testing/reliability/fixtures";
import { expectSettledExecution } from "#src/backend/testing/reliability/assertions";
import { reliabilityProperty } from "#src/backend/testing/reliability/property";

/**
 * How long `app.dispose()` may take once every run has ended. A healthy dispose
 * takes milliseconds; a dispose held open by a parked invocation never settles.
 */
const DISPOSE_BUDGET_MS = 5_000;

// A prefix action followed by two actions that run in parallel, either as the
// two branches of a fan-out or as the two arms of a join. Inngest plans the two
// parallel steps together and leaves the invocation that planned them parked.
// Once the Execution completes, disposing the app must settle promptly.
const disposeScenarios = fc.record({
  shape: fc.constantFrom("fanout", "join"),
});
reliabilityProperty<{ shape: "fanout" | "join" }>(
  "App dispose settles after parallel action steps",
  disposeScenarios,
  [{ shape: "fanout" }, { shape: "join" }],
  async (host, scenario) => {
    const workflowId = await host.publish(parallelWorkflow(scenario.shape));

    await host.runtime.send(START, { entityId: "subject", marker: "start" });
    await expectSettledExecution(host, workflowId, "completed");

    const markers = host.ledger.map((entry) => entry.marker).sort();
    expect(markers).toEqual(
      scenario.shape === "fanout"
        ? ["left", "prefix", "right"]
        : ["join", "left", "prefix", "right"]
    );

    const disposed = await Promise.race([
      host.dispose().then(() => true),
      delay(DISPOSE_BUDGET_MS).then(() => false),
    ]);
    expect(disposed).toBe(true);
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
