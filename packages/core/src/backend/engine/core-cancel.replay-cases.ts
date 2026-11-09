/**
 * The Canceled-outlet fixtures, and the cases the cancel suite runs under the
 * replay driver: a Cancel claim that lands after the last boundary read, and a
 * Canceled-side Wait the run parks on.
 */

import { Effect, Schema } from "effect";
import { beforeEach, expect, it } from "vitest";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { unknownRest } from "@wfgraph/shared/types/schema";
import { defineAction } from "#src/backend/extensions/define-action";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import type { WaitWake } from "#src/backend/engine/runtime";
import type { PendingCancel, WorkflowStore } from "#src/backend/engine/store";
import {
  driveWithReplay,
  type ReplayExecutor,
} from "#src/backend/engine/testing/replay-runtime";

const PRODUCER_ACTION_ID = "test/cancel-producer";
const RECORDER_ACTION_ID = "test/cancel-recorder";

/** What each Recorder node was handed, keyed by node label. */
export const recorded: Record<string, Record<string, unknown>> = {};

/** Empties `recorded`, which every case does before it runs. */
export function clearRecorded(): void {
  for (const label of Object.keys(recorded)) {
    delete recorded[label];
  }
}

export const actions = createWorkflowActions(
  assembleExtensions({
    actions: [
      defineAction({
        id: PRODUCER_ACTION_ID,
        label: "Producer",
        description: "Produces the output the Canceled branch reads back",
        input: Schema.Struct({}),
        handler: () => ({ orderId: "o_1" }),
      }),
      defineAction({
        id: RECORDER_ACTION_ID,
        label: "Recorder",
        description: "Records the config it was handed",
        // Each case hands this action a config of its own, so the shape stays
        // open: a declared field list would decode the keys under test away.
        input: Schema.StructWithRest(Schema.Struct({}), unknownRest),
        handler: ({ input }) => {
          const label = typeof input.label === "string" ? input.label : "";
          // A node configured with `throws` raises the way any handler that
          // fails does, which is how a case fails one node of a branch without
          // failing the run around it.
          if (input.throws === true) {
            throw new Error(`${label} exploded`);
          }
          recorded[label] = input;
          return { seen: label };
        },
      }),
    ],
  }),
  stubWfGraphRuntime()
);

export const CANCEL: PendingCancel = {
  eventName: "billing/subscription.canceled",
  payload: { reason: "customer left", entityId: "sub_9" },
};

/**
 * The entry node, declaring a Cancel Event.
 *
 * The declaration is what buys the boundary read: only a Cancel Event ever
 * stamps the flag, so the engine skips the read outright for a graph naming
 * none, and a run of a rules-free graph would reach no Canceled branch here.
 */
export function createLifecycleNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvents: ["app/appointment.created"],
          cancelEvents: ["app/appointment.canceled"],
          concurrency: "unlimited",
        },
      },
    },
  };
}

export function createProducerNode(id: string, label: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action", config: { actionType: PRODUCER_ACTION_ID } },
  };
}

export function createRecorderNode(
  id: string,
  label: string,
  config: Record<string, unknown> = {}
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config: { actionType: RECORDER_ACTION_ID, label, ...config },
    },
  };
}

export function lifecycleEdge(
  id: string,
  target: string,
  outlet: "started" | "canceled"
): WorkflowEdge {
  return { id, source: "lifecycle_1", sourceHandle: outlet, target };
}

/**
 * Started: Producer, then a node that must not run once the cancel lands.
 * Canceled: one Recorder addressing both the payload that canceled the run and
 * the output the Started branch already left behind.
 */
const cancelGraph = createSerializedWorkflowGraph({
  nodes: [
    createLifecycleNode("lifecycle_1"),
    createProducerNode("producer_1", "Producer"),
    createRecorderNode("after_1", "After"),
    createRecorderNode("cleanup_1", "Cleanup", {
      reason: "{{@lifecycle_1:Lifecycle.reason}}",
      orderId: "{{@producer_1:Producer.orderId}}",
    }),
  ],
  edges: [
    lifecycleEdge("edge_started", "producer_1", "started"),
    { id: "edge_after", source: "producer_1", target: "after_1" },
    lifecycleEdge("edge_canceled", "cleanup_1", "canceled"),
  ],
});

export const cancelInput = {
  graph: cancelGraph,
  startPayload: { reason: "started normally", entityId: "sub_9" },
  executionId: "exec_cancel",
  workflowId: "workflow_cancel",
};

/**
 * Stamps a Cancel claim on the recording store's execution row, as a Cancel
 * Event arriving at that moment does. The boundary read of the recording store
 * still answers null, which is the truth for a claim landing after the last
 * node's boundary read.
 */
export function landCancelClaim(store: RecordingWorkflowStore) {
  store.terminationState = {
    status: "running",
    claim: {
      kind: "cancel",
      requestedAt: "2026-10-19T15:00:00.000Z",
      eventName: CANCEL.eventName,
      payload: CANCEL.payload,
    },
    didWrite: false,
  };
}

/** A store whose Cancel claim lands just before the run reads its outcome. */
function claimBeforeOutcomeRead(store: RecordingWorkflowStore): WorkflowStore {
  return {
    ...store,
    readTerminationState: (executionId) =>
      Effect.suspend(() => {
        landCancelClaim(store);
        return store.readTerminationState(executionId);
      }),
  };
}

/**
 * A store whose Cancel claim lands just before the first terminal write, after
 * the run read its outcome. With `databaseError` the first write also fails,
 * the way a lost connection does, and the claim is found by the retry.
 */
export function claimAtTerminalWrite(
  store: RecordingWorkflowStore,
  databaseError?: DatabaseError
): WorkflowStore {
  let writes = 0;
  return {
    ...store,
    completeRun: (input) =>
      Effect.suspend(() => {
        writes += 1;
        if (writes > 1) {
          return store.completeRun(input);
        }
        landCancelClaim(store);
        return databaseError
          ? Effect.fail(databaseError)
          : store.completeRun(input);
      }),
  };
}

/** The `run_cancelled` rows the run wrote to its timeline. */
export function cancelledAudits(store: RecordingWorkflowStore) {
  return store.timeline.filter((event) => event.eventType === "run_cancelled");
}

/**
 * How many run-log rows the run opened for one node. The row opens inside a
 * memoized step, so it counts how often the node ran across every replay. A
 * handler body is not a step (ADR-0009) and runs again on each replay, so the
 * handler's own calls cannot tell a replay from a second run.
 */
export function rowsOpenedFor(store: RecordingWorkflowStore, nodeId: string) {
  return store.callsOf("startStepLog").filter((row) => row.nodeId === nodeId)
    .length;
}

/** The Canceled outlet, opening with one Wait and one Recorder behind it. */
function createCanceledWaitGraph(waitConfig: Record<string, unknown>) {
  return createSerializedWorkflowGraph({
    nodes: [
      createLifecycleNode("lifecycle_1"),
      createProducerNode("producer_1", "Producer"),
      {
        id: "grace_1",
        type: "action",
        position: { x: 0, y: 0 },
        data: {
          label: "Grace Period",
          type: "action",
          config: { actionType: "Wait", ...waitConfig },
        },
      },
      createRecorderNode("cleanup_1", "Cleanup", {
        reason: "{{@lifecycle_1:Lifecycle.reason}}",
        invoiceId: "{{@lifecycle_1:Lifecycle.invoiceId}}",
      }),
    ],
    edges: [
      lifecycleEdge("edge_started", "producer_1", "started"),
      lifecycleEdge("edge_canceled", "grace_1", "canceled"),
      { id: "edge_cleanup", source: "grace_1", target: "cleanup_1" },
    ],
  });
}

/** The wake an arriving `billing/payment.settled` Event resumes the Wait with. */
const SETTLED_WAKE: WaitWake = {
  kind: "resume",
  eventName: "billing/payment.settled",
  payload: { invoiceId: "inv_1" },
};

export function defineCancelReplayCases(executor: ReplayExecutor): void {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    clearRecorded();
  });

  it("runs the Canceled outlet once before recording canceled when the claim lands before the outcome read", async () => {
    const run = await driveWithReplay(
      (runtime) =>
        executeWorkflow(
          cancelInput,
          runtime,
          claimBeforeOutcomeRead(store),
          actions
        ),
      { executor, waitRows: store }
    );

    expect(run.value.status).toBe("canceled");
    // The Started branch finished before the claim, so After ran too.
    expect(rowsOpenedFor(store, "after_1")).toBe(1);
    expect(rowsOpenedFor(store, "cleanup_1")).toBe(1);
    expect(recorded.Cleanup).toMatchObject({
      reason: "customer left",
      orderId: "o_1",
    });
    expect(
      store.callsOf("completeRun").map((call) => call.verdict.status)
    ).toEqual(["canceled"]);
    expect(cancelledAudits(store)).toEqual([
      expect.objectContaining({
        message: "Run canceled at the Canceled outlet",
      }),
    ]);
    expect(
      run.executed.filter((step) => step.stepId === "workflow-run-canceled")
    ).toEqual([]);
  });

  it("runs the Canceled outlet once when the claim refuses the completed record", async () => {
    const run = await driveWithReplay(
      (runtime) =>
        executeWorkflow(
          cancelInput,
          runtime,
          claimAtTerminalWrite(store),
          actions
        ),
      { executor, waitRows: store }
    );

    expect(run.value.status).toBe("canceled");
    expect(rowsOpenedFor(store, "after_1")).toBe(1);
    expect(rowsOpenedFor(store, "cleanup_1")).toBe(1);
    expect(recorded.Cleanup).toMatchObject({ reason: "customer left" });
    expect(
      store.callsOf("completeRun").map((call) => call.verdict.status)
    ).toEqual(["completed", "canceled"]);
    expect(store.terminationState?.status).toBe("canceled");
    expect(cancelledAudits(store)).toEqual([
      expect.objectContaining({
        message: "Run canceled at the Canceled outlet",
        // The outlet ran for the claim that refused the completed record, and
        // the timeline says so, as it does on the path a fatal error ended.
        metadata: expect.objectContaining({ canceledOutlet: "ran" }),
      }),
    ]);
    expect(
      store.timeline
        .map((event) => event.eventType)
        .filter((eventType) => eventType === "run_completed")
    ).toEqual([]);
    const terminalSteps = run.executed
      .map((step) => step.stepId)
      .filter((stepId) => stepId.startsWith("workflow-run-"));
    expect(terminalSteps).toEqual([
      "workflow-run-completed",
      "workflow-run-canceled",
    ]);
  });

  // The outlet may open with a Wait, which parks the run between the refused
  // completion and the canceled record. The run wakes into the memoized claim
  // and carries on down the Canceled branch.
  it("parks on a Wait behind the Canceled outlet and records canceled after it", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createProducerNode("producer_1", "Producer"),
        {
          id: "grace_1",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Grace Period",
            type: "action",
            config: {
              actionType: "Wait",
              waitMode: "delay",
              waitDuration: "1h",
            },
          },
        },
        createRecorderNode("cleanup_1", "Cleanup"),
      ],
      edges: [
        lifecycleEdge("edge_started", "producer_1", "started"),
        lifecycleEdge("edge_canceled", "grace_1", "canceled"),
        { id: "edge_cleanup", source: "grace_1", target: "cleanup_1" },
      ],
    });

    const run = await driveWithReplay(
      (runtime) =>
        executeWorkflow(
          { ...cancelInput, graph },
          runtime,
          claimAtTerminalWrite(store),
          actions
        ),
      { executor, waitRows: store }
    );

    expect(run.value.status).toBe("canceled");
    // The Wait's due time is taken from the wall clock, so the run's clock can
    // land a millisecond short of the full hour.
    expect(run.elapsedMs).toBeGreaterThan(59 * 60 * 1000);
    expect(run.elapsedMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(rowsOpenedFor(store, "cleanup_1")).toBe(1);
    expect(recorded.Cleanup).toBeDefined();
    expect(store.callsOf("createWaitState")).toHaveLength(1);
    // The park names the Canceled side, which is what the run's own Cancel claim
    // admits. The same park on the Started side is refused (`core-wait.test.ts`).
    expect(store.callsOf("createWaitState")[0]?.side).toBe("canceled");
    expect(
      store.callsOf("completeRun").map((call) => call.verdict.status)
    ).toEqual(["completed", "canceled"]);
    expect(cancelledAudits(store)).toHaveLength(1);
  });

  /**
   * Drives a graph whose Canceled outlet opens with a Wait. The run that took
   * the outlet parks on the Wait where it stands and runs again once the park
   * resolves.
   */
  function driveCanceledWait(
    waitConfig: Record<string, unknown>,
    events: Record<string, WaitWake> = {}
  ) {
    const input = {
      ...cancelInput,
      graph: createCanceledWaitGraph(waitConfig),
    };
    const claiming = claimBeforeOutcomeRead(store);

    return driveWithReplay(
      (runtime) => executeWorkflow(input, runtime, claiming, actions),
      { events, executor, waitRows: store }
    );
  }

  // The run already holds the claim, so the node below the Wait addresses the
  // canceling payload as the entry node's output.
  it("parks a Canceled-side Wait and reads the canceling payload below it", async () => {
    const run = await driveCanceledWait({
      waitMode: "delay",
      waitDuration: "1h",
    });

    expect(store.callsOf("createWaitState")[0]?.side).toBe("canceled");
    expect(store.callsOf("markExecutionRunning")[0]?.side).toBe("canceled");
    // The entry node's output on this side is the payload the Cancel Event
    // carried.
    expect(recorded.Cleanup).toMatchObject({ reason: "customer left" });
    expect(run.value.status).toBe("canceled");
    expect(
      store.callsOf("completeRun").map((call) => call.verdict.status)
    ).toEqual(["canceled"]);
    expect(cancelledAudits(store)).toHaveLength(1);
  });

  // An Event reaches the Canceled-side Wait the way it reaches a Started-side
  // one: the row is listed, claimed and resumed under the run's Cancel claim.
  // The Event that woke the Wait becomes the Arriving Event below it, which is
  // what replaces the canceling payload on the entry node.
  it("wakes a Canceled-side Wait on an Event and carries that Event below it", async () => {
    const run = await driveCanceledWait(
      {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      { "wait-park-grace_1-0": SETTLED_WAKE }
    );

    const parked = store.callsOf("createWaitState")[0];
    expect(parked?.side).toBe("canceled");
    expect(parked?.subscribedEvents).toEqual(["billing/payment.settled"]);
    expect(store.callsOf("markExecutionRunning")[0]?.side).toBe("canceled");
    expect(store.callsOf("markWaitStateStatus")).toEqual([
      { waitStateId: "wait_state_1", status: "resumed" },
    ]);
    expect(recorded.Cleanup).toMatchObject({ invoiceId: "inv_1" });
    expect(run.value.status).toBe("canceled");
    expect(cancelledAudits(store)).toHaveLength(1);
  });
}
