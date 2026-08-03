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
import { Effect, Schema } from "effect";
import { unknownRest } from "@rova/shared/types/schema";
import { BUILT_IN_ACTION_IDS } from "@rova/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import { eventSplitOutlet } from "@rova/shared/lifecycle/event-split";
import type { WorkflowNode } from "@rova/shared/graph/types";
import type { JsonObject } from "@rova/shared/types/json";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import type { PendingCancel, WorkflowStore } from "#src/backend/engine/store";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { defineAction } from "#src/backend/extensions/define-action";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";
import {
  executeWorkflow,
  executeWorkflowBranch,
} from "#src/backend/engine/core";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { driveWithReplay } from "#src/backend/engine/replay-runtime";

const SEND_ACTION_ID = "test/send";
const ECHO_ACTION_ID = "test/echo";
const WRAP_ACTION_ID = "test/wrap";
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

/**
 * What a `wrap` node answers with: a payload of its own that happens to be
 * shaped like a step envelope, which a vendor body carrying a `success` flag
 * beside its data often is.
 *
 * It is the payload that tells a stored row and an in-run output apart. Every
 * reader steps through one envelope, so read bare this one is stepped through a
 * second time and `id` resolves to nothing.
 */
const WRAPPER_SHAPED_PAYLOAD = {
  success: true,
  data: { note: "envelope" },
  id: "inner",
};

const wrapAction = defineAction({
  id: WRAP_ACTION_ID,
  label: "Wrap",
  description: "Answers with a payload shaped like a step envelope",
  input: Schema.Struct({}),
  handler: () => WRAPPER_SHAPED_PAYLOAD,
});

/** What the last `echo` node was handed, once its templates were resolved. */
let echoedConfig: unknown;

/**
 * An action that records the config it ran with, for the one question a branch
 * run answers differently: what the nodes above its entry left behind.
 */
const echoAction = defineAction({
  id: ECHO_ACTION_ID,
  label: "Echo",
  description: "Records the config it was handed",
  input: Schema.StructWithRest(Schema.Struct({}), unknownRest),
  handler: async ({ input, step }) => {
    await step.run("dispatch", () => Promise.resolve(null));
    echoedConfig = input;
    return {};
  },
});

const actions = createWorkflowActions(
  assembleExtensions({ actions: [sendAction, echoAction, wrapAction] }),
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

/**
 * Drives one graph the way a live run goes: a root run, and one branch run per
 * Wait the root hands off. Every run writes to the one store, which is how a
 * branch reads the outputs of the nodes above it.
 */
function runGraph(
  graph: ReturnType<typeof createSerializedWorkflowGraph>,
  options: { killBranchesAtMs?: number; store?: WorkflowStore } = {}
) {
  const { store = createRecordingWorkflowStore(), ...replayOptions } = options;
  const input = {
    graph,
    executionId: "exec_parallel",
    workflowId: "workflow_parallel",
    startEventName: START_EVENT,
    startPayload: { appointment: { id: "123" } },
  };

  return driveWithReplay(
    (runtime) => executeWorkflow(input, runtime, store, actions),
    {
      ...replayOptions,
      branch: (runtime, branchInput) =>
        executeWorkflowBranch(
          { ...input, ...branchInput },
          runtime,
          store,
          actions
        ),
    }
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

  it("runs a short branch at its own target while a long sibling is still parked", async () => {
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

    // The defect this design exists to remove. A run wakes once, at the last of
    // its outstanding pauses, so both waits on one run put the 30-second branch
    // nine and a half minutes late. Each waiting branch holds its own run, so
    // the short one lands on its own target.
    expect(dispatchClock(run.executed, "after_short")).toBeLessThan(60_000);
    // The root, and one run per waiting branch.
    expect(run.runs).toBe(3);
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

  it("resolves a template behind the wait against a node above it", async () => {
    echoedConfig = undefined;

    const run = await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          sendNode("notify"),
          waitNode("wait_before", "30s"),
          actionNode("follow_up", {
            actionType: ECHO_ACTION_ID,
            subject: "{{@notify:Notify.sent}}",
          }),
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
            source: "notify",
            sourceHandle: null,
            target: "wait_before",
          },
          {
            id: "e3",
            source: "wait_before",
            sourceHandle: null,
            target: "follow_up",
          },
        ],
      })
    );

    expect(run.value.success).toBe(true);
    // The branch run walked none of the graph above its entry node, so this
    // value came back out of the store rather than out of a traversal.
    expect(echoedConfig).toMatchObject({ subject: "true" });
  });

  /**
   * A node's stored row holds the step's payload while a traversal holds the
   * envelope around it, and every reader steps through one envelope. A payload
   * that is itself `{ success, data }` is where that difference shows: read back
   * bare, it would be stepped through twice and the template would resolve
   * against the wrong object.
   */
  it("reads an inherited output the way the run above it would have", async () => {
    echoedConfig = undefined;

    await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          actionNode("wrapped", { actionType: WRAP_ACTION_ID }),
          waitNode("wait_before", "30s"),
          actionNode("follow_up", {
            actionType: ECHO_ACTION_ID,
            subject: "{{@wrapped:Wrap.id}}",
          }),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "wrapped",
          },
          {
            id: "e2",
            source: "wrapped",
            sourceHandle: null,
            target: "wait_before",
          },
          {
            id: "e3",
            source: "wait_before",
            sourceHandle: null,
            target: "follow_up",
          },
        ],
      })
    );

    expect(echoedConfig).toMatchObject({ subject: "inner" });
  });

  /**
   * The rows a killed branch leaves behind. It was stopped where it stood, so
   * nothing inside it can close its own row, and the run that started it is
   * the only thing alive that knows the Execution.
   */
  it("closes what a killed branch left open before taking the Canceled outlet", async () => {
    const store = createRecordingWorkflowStore();
    let reads = 0;
    const cancelStore: WorkflowStore = {
      ...store,
      // The entry node reads first and finds nothing, which is what lets the
      // wait be handed off at all. The cancel lands while the branch is parked,
      // and the node that handed it off is the next to ask.
      readPendingCancel: (executionId: string) =>
        Effect.gen(function* () {
          yield* store.readPendingCancel(executionId);
          reads += 1;
          return reads === 1
            ? null
            : ({
                eventName: "app/appointment.canceled",
                payload: {},
              } satisfies PendingCancel);
        }),
    };

    const run = await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry", CANCELABLE),
          waitNode("wait_before", "10m"),
          sendNode("reminder"),
          sendNode("canceled_sms"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "wait_before",
          },
          {
            id: "e2",
            source: "wait_before",
            sourceHandle: null,
            target: "reminder",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "canceled",
            target: "canceled_sms",
          },
        ],
      }),
      { store: cancelStore, killBranchesAtMs: 30_000 }
    );

    // The branch died mid-sleep, so the node behind it never ran.
    expect(dispatchClock(run.executed, "reminder")).toBeUndefined();
    expect(store.callsOf("cancelOpenWork")).toHaveLength(1);

    // Order is the whole of what makes the sweep safe: after the kill was
    // observed, before the Canceled branch opened a row of its own.
    const sweptAt = store.calls.findIndex(
      (call) => call.method === "cancelOpenWork"
    );
    const canceledBranchAt = store.calls.findIndex(
      (call) =>
        call.method === "startStepLog" && call.input.nodeId === "canceled_sms"
    );
    expect(sweptAt).toBeGreaterThanOrEqual(0);
    expect(sweptAt).toBeLessThan(canceledBranchAt);
    expect(store.callsOf("completeRun")[0]?.status).toBe("canceled");
  });

  it("carries a failure inside a branch back as that node's own", async () => {
    const run = await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          waitNode("wait_before", "30s"),
          // No action type, which is a node that fails without running.
          actionNode("broken", {}),
          sendNode("elsewhere"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "wait_before",
          },
          {
            id: "e2",
            source: "wait_before",
            sourceHandle: null,
            target: "broken",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "started",
            target: "elsewhere",
          },
        ],
      })
    );

    // The run answers for what its branch did, and for that node alone: the
    // branch beside it succeeded and the Wait it hung off did too.
    expect(run.value.success).toBe(false);
    expect(run.value.results.broken?.success).toBe(false);
    expect(run.value.results.wait_before?.success).toBe(true);
    expect(run.value.results.elsewhere?.success).toBe(true);
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
      readPendingCancel: (executionId: string) =>
        Effect.gen(function* () {
          yield* store.readPendingCancel(executionId);
          reads += 1;
          return reads === 1
            ? null
            : ({
                eventName: "app/appointment.canceled",
                payload: {},
              } satisfies PendingCancel);
        }),
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
