/**
 * What a Wait node costs the branches beside it.
 *
 * A durable runtime suspends the run rather than the branch, so these cases run
 * through `driveWithReplay` instead of the in-memory runtime: only a driver that
 * abandons the body at a step boundary can show a branch stopping there. The
 * graph is the one that surfaced the defect, an entry node whose Started outlet
 * feeds both an Event Split and a Wait.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import { eventSplitOutlet } from "@rova/shared/lifecycle/event-split";
import type { WorkflowNode } from "@rova/shared/graph/types";
import type { JsonObject } from "@rova/shared/types/json";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import type { PendingCancel } from "#src/backend/engine/store";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { defineAction } from "#src/backend/extensions/define-action";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";
import { executeWorkflow } from "#src/backend/engine/core";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { driveWithReplay } from "#src/backend/engine/replay-runtime";

const SEND_ACTION_ID = "test/send";
const START_EVENT = "app/appointment.created";

/**
 * An action whose work sits in a durable step, which is what a real one does
 * with a side effect. The step is the boundary a stalled branch stops at, so a
 * handler doing its work inline would have nothing to observe.
 */
const sendAction = defineAction({
  id: SEND_ACTION_ID,
  label: "Send",
  description: "Runs one durable step",
  input: Schema.Struct({}),
  handler: async ({ step }) => {
    await step.run("dispatch", () => Promise.resolve(null));
    return { sent: true };
  },
});

const actions = createWorkflowActions(
  assembleExtensions({ actions: [sendAction] }),
  stubRovaRuntime()
);

function lifecycleNode(id: string, config: JsonObject = {}): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Appointments", type: "lifecycle", config },
  };
}

/** Only a graph declaring a Cancel Event ever buys the boundary read. */
const CANCELABLE: JsonObject = {
  lifecycleRules: {
    concurrency: "newest-wins",
    startEvents: [START_EVENT],
    cancelEvents: ["app/appointment.canceled"],
    allowManualStart: true,
  },
};

function actionNode(id: string, config: Record<string, unknown>): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config },
  };
}

function sendNode(id: string): WorkflowNode {
  return actionNode(id, { actionType: SEND_ACTION_ID });
}

function waitNode(id: string, waitDuration: string): WorkflowNode {
  return actionNode(id, {
    actionType: BUILT_IN_ACTION_IDS.wait,
    waitMode: "delay",
    waitDuration,
    waitGateMode: "require_actual_wait",
  });
}

/** The clock at which a node's own step ran, or undefined if it never did. */
function dispatchClock(
  executed: ReadonlyArray<{ stepId: string; at: number }>,
  nodeId: string
): number | undefined {
  return executed.find((step) => step.stepId === `node:${nodeId}:dispatch`)?.at;
}

function runGraph(graph: ReturnType<typeof createSerializedWorkflowGraph>) {
  const store = createRecordingWorkflowStore();

  return driveWithReplay((runtime) =>
    executeWorkflow(
      {
        graph,
        executionId: "exec_parallel",
        workflowId: "workflow_parallel",
        startEventName: START_EVENT,
        startPayload: { appointment: { id: "123" } },
      },
      runtime,
      store,
      actions
    )
  );
}

describe("a wait node beside another branch", () => {
  it("lets the branch that suspends nothing finish before the run parks", async () => {
    const run = await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          actionNode("split", {
            actionType: BUILT_IN_ACTION_IDS.eventSplit,
          }),
          sendNode("scheduled_sms"),
          waitNode("wait_before", "30s"),
          sendNode("reminder"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "split",
          },
          {
            id: "e2",
            source: "split",
            sourceHandle: eventSplitOutlet(START_EVENT),
            target: "scheduled_sms",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "started",
            target: "wait_before",
          },
          {
            id: "e4",
            source: "wait_before",
            sourceHandle: null,
            target: "reminder",
          },
        ],
      })
    );

    expect(run.value.success).toBe(true);
    expect(dispatchClock(run.executed, "scheduled_sms")).toBe(0);
    expect(dispatchClock(run.executed, "reminder")).toBeGreaterThan(25_000);
  });

  it("holds the branch behind a short wait until its long sibling fires", async () => {
    const run = await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          waitNode("short_wait", "30s"),
          sendNode("after_short"),
          waitNode("long_wait", "10m"),
          sendNode("after_long"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "short_wait",
          },
          {
            id: "e2",
            source: "short_wait",
            sourceHandle: null,
            target: "after_short",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "started",
            target: "long_wait",
          },
          {
            id: "e4",
            source: "long_wait",
            sourceHandle: null,
            target: "after_long",
          },
        ],
      })
    );

    // Both timers run at once, so the run costs the longer of the two rather
    // than their sum.
    expect(run.elapsedMs).toBeLessThan(11 * 60 * 1000);
    expect(dispatchClock(run.executed, "after_long")).toBeGreaterThan(
      9 * 60 * 1000
    );

    // What the drain cannot reach. Inngest wakes a run once, at the last of its
    // outstanding pauses, so the 30-second branch runs when the ten-minute one
    // does. Removing this needs a durable run per waiting branch.
    expect(dispatchClock(run.executed, "after_short")).toBe(
      dispatchClock(run.executed, "after_long")
    );
  });

  it("takes a second wait further down the same branch on a later pass", async () => {
    const run = await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          sendNode("notify"),
          waitNode("first_wait", "30s"),
          waitNode("second_wait", "30s"),
          sendNode("follow_up"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "notify",
          },
          {
            id: "e2",
            source: "entry",
            sourceHandle: "started",
            target: "first_wait",
          },
          {
            id: "e3",
            source: "first_wait",
            sourceHandle: null,
            target: "second_wait",
          },
          {
            id: "e4",
            source: "second_wait",
            sourceHandle: null,
            target: "follow_up",
          },
        ],
      })
    );

    expect(run.value.success).toBe(true);
    expect(dispatchClock(run.executed, "notify")).toBe(0);
    // Two waits in a row, so the branch behind them costs both.
    expect(dispatchClock(run.executed, "follow_up")).toBeGreaterThan(55_000);
  });

  /**
   * A wait held back is the one thing a run carries across the Canceled outlet.
   * Every other node on the Started branch stops there by never being scheduled,
   * so this is the case the queue has to answer for itself.
   */
  it("drops a held-back wait once the run has taken the Canceled outlet", async () => {
    const store = createRecordingWorkflowStore();
    let reads = 0;
    const cancelStore = {
      ...store,
      // The entry node reads first and finds nothing, which is what lets the
      // Started branch fan out and park its wait in the queue. The cancel lands
      // at the node after it.
      readPendingCancel: async (executionId: string) => {
        await store.readPendingCancel(executionId);
        reads += 1;
        return reads === 1
          ? null
          : ({
              eventName: "app/appointment.canceled",
              payload: {},
            } satisfies PendingCancel);
      },
    };

    const result = await executeWorkflow(
      {
        graph: createSerializedWorkflowGraph({
          nodes: [
            lifecycleNode("entry", CANCELABLE),
            sendNode("scheduled_sms"),
            waitNode("wait_before", "30s"),
            sendNode("reminder"),
            sendNode("canceled_sms"),
          ],
          edges: [
            {
              id: "e1",
              source: "entry",
              sourceHandle: "started",
              target: "scheduled_sms",
            },
            {
              id: "e2",
              source: "entry",
              sourceHandle: "started",
              target: "wait_before",
            },
            {
              id: "e3",
              source: "wait_before",
              sourceHandle: null,
              target: "reminder",
            },
            {
              id: "e4",
              source: "entry",
              sourceHandle: "canceled",
              target: "canceled_sms",
            },
          ],
        }),
        executionId: "exec_cancel",
        workflowId: "workflow_cancel",
        startEventName: START_EVENT,
      },
      createInMemoryWorkflowRuntime({ skipSleep: true }),
      cancelStore,
      actions
    );

    expect(result.success).toBe(true);
    // No wait state, so the run never parked on a branch it had left.
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(store.callsOf("startStepLog").map((open) => open.nodeId)).toEqual([
      "entry",
      "scheduled_sms",
      "canceled_sms",
    ]);
  });
});
