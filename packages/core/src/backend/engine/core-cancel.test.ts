/**
 * The Canceled outlet, as the engine walks it.
 *
 * A cancellation is a routed continuation (ADR-0007): the authority is a flag on
 * the execution row, and the engine reads it at each node boundary inside a step.
 * These cases drive that flag through the store port and pin what a run does with
 * it -- which outlet it leaves the entry node by, what the branch can address, and
 * the status the run ends on.
 */

import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { unknownRest } from "@rova/shared/types/schema";
import { defineAction } from "#src/backend/extensions/define-action";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/graph/types";
import { executeWorkflow } from "#src/backend/engine/core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import type { PendingCancel, WorkflowStore } from "#src/backend/engine/store";

const PRODUCER_ACTION_ID = "test/cancel-producer";
const RECORDER_ACTION_ID = "test/cancel-recorder";

/** What each Recorder node was handed, keyed by node label. */
let recorded: Record<string, Record<string, unknown>> = {};

const actions = createWorkflowActions(
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
          const label = String(input.label ?? "");
          recorded[label] = input;
          return { seen: label };
        },
      }),
    ],
  }),
  stubRovaRuntime()
);

const CANCEL: PendingCancel = {
  eventName: "billing/subscription.canceled",
  payload: { reason: "customer left", entityId: "sub_9" },
};

/**
 * A store that answers the boundary read from a script, one entry per read, and
 * `null` once the script runs out. Every other write still lands on the
 * recording store the case asserts against.
 */
function withCancelAnswers(
  store: RecordingWorkflowStore,
  answers: (PendingCancel | null)[]
): WorkflowStore {
  let reads = 0;
  return {
    ...store,
    readPendingCancel: async (executionId) => {
      await store.readPendingCancel(executionId);
      const answer = answers[reads] ?? null;
      reads += 1;
      return answer;
    },
  };
}

/**
 * The entry node, declaring a Cancel Event.
 *
 * The declaration is what buys the boundary read: only a Cancel Event ever
 * stamps the flag, so the engine skips the read outright for a graph naming
 * none, and a run of a rules-free graph would reach no Canceled branch here.
 */
function createLifecycleNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {
        lifecycleRules: {
          startEvent: "app/appointment.created",
          cancelEvents: ["app/appointment.canceled"],
          concurrency: "unlimited",
        },
      },
    },
  };
}

function createProducerNode(id: string, label: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label, type: "action", config: { actionType: PRODUCER_ACTION_ID } },
  };
}

function createRecorderNode(
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

function createWaitNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Wait",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
    },
  };
}

function lifecycleEdge(
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

const cancelInput = {
  graph: cancelGraph,
  startPayload: { reason: "started normally", entityId: "sub_9" },
  executionId: "exec_cancel",
  workflowId: "workflow_cancel",
};

describe("a run claimed for the Canceled outlet", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    recorded = {};
  });

  it("routes to the Canceled branch, which reads the canceling payload and the outputs already landed", async () => {
    // The flag lands while the Producer is running: the entry node's boundary
    // read is clean, the Producer's is not.
    const result = await executeWorkflow(
      cancelInput,
      createInMemoryWorkflowRuntime(),
      withCancelAnswers(store, [null, CANCEL]),
      actions
    );

    expect(Object.keys(recorded)).toEqual(["Cleanup"]);
    expect(recorded.Cleanup).toMatchObject({
      reason: "customer left",
      orderId: "o_1",
    });
    expect(result.results.after_1).toBeUndefined();

    const completions = store.callsOf("completeRun");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.status).toBe("canceled");
    expect(store.callsOf("recordAuditEvent").at(-1)).toMatchObject({
      eventType: "run_cancelled",
      message: "Run canceled at the Canceled outlet",
    });
  });

  it("ends canceled with nothing to run when the Canceled outlet has no edge", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createProducerNode("producer_1", "Producer"),
        createRecorderNode("after_1", "After"),
      ],
      edges: [
        lifecycleEdge("edge_started", "producer_1", "started"),
        { id: "edge_after", source: "producer_1", target: "after_1" },
      ],
    });

    await executeWorkflow(
      { ...cancelInput, graph },
      createInMemoryWorkflowRuntime(),
      withCancelAnswers(store, [null, CANCEL]),
      actions
    );

    expect(recorded).toEqual({});
    expect(store.callsOf("completeRun")[0]?.status).toBe("canceled");
  });

  it("ends completed when the run finished before any cancel landed", async () => {
    const result = await executeWorkflow(
      cancelInput,
      createInMemoryWorkflowRuntime(),
      withCancelAnswers(store, []),
      actions
    );

    expect(result.success).toBe(true);
    expect(Object.keys(recorded)).toEqual(["After"]);
    expect(store.callsOf("completeRun")[0]?.status).toBe("completed");
    // One read per node the run walked: entry, Producer, After.
    expect(store.callsOf("readPendingCancel")).toHaveLength(3);
  });

  // The flag is read inside a step, so the branch a run took is part of what the
  // runtime remembers. A replay against a row that no longer answers the same way
  // must still walk the branch it walked, or the memoized outputs belong to a run
  // that never happened.
  it("takes the same branch on a replay, and runs it once", async () => {
    const memo = new Map<string, unknown>();

    await executeWorkflow(
      cancelInput,
      createInMemoryWorkflowRuntime({ memo }),
      withCancelAnswers(store, [null, CANCEL]),
      actions
    );

    const replayed = await executeWorkflow(
      cancelInput,
      createInMemoryWorkflowRuntime({ memo }),
      // The replay asks a database that has forgotten: only the memo answers now.
      withCancelAnswers(store, []),
      actions
    );

    expect(Object.keys(recorded)).toEqual(["Cleanup"]);
    expect(replayed.results.after_1).toBeUndefined();
    expect(store.callsOf("completeRun")).toHaveLength(1);
  });

  // The Started branch can be several nodes wide, and the cancel is read by one
  // of them first. Whichever reads it second is on a run that is already ending,
  // so it schedules nothing either.
  it("stops a sibling of the node that read the cancel", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createProducerNode("fan_1", "Fan Out"),
        createRecorderNode("left_1", "Left"),
        createRecorderNode("right_1", "Right"),
        createRecorderNode("left_2", "Left Next"),
        createRecorderNode("right_2", "Right Next"),
        createRecorderNode("cleanup_1", "Cleanup"),
      ],
      edges: [
        lifecycleEdge("edge_started", "fan_1", "started"),
        { id: "edge_left", source: "fan_1", target: "left_1" },
        { id: "edge_right", source: "fan_1", target: "right_1" },
        { id: "edge_left_next", source: "left_1", target: "left_2" },
        { id: "edge_right_next", source: "right_1", target: "right_2" },
        lifecycleEdge("edge_canceled", "cleanup_1", "canceled"),
      ],
    });

    await executeWorkflow(
      { ...cancelInput, graph },
      createInMemoryWorkflowRuntime(),
      withCancelAnswers(store, [null, null, CANCEL, CANCEL]),
      actions
    );

    expect(Object.keys(recorded).toSorted()).toEqual([
      "Cleanup",
      "Left",
      "Right",
    ]);
    expect(store.callsOf("completeRun")[0]?.status).toBe("canceled");
  });

  // A parked run reaches no boundary of its own, so a Cancel Event nudges it
  // awake through the wait signal. The nudge closes the wait row as "cancelled";
  // where the run goes next is the boundary read's answer, like every other node.
  it("routes a Wait woken by a cancel nudge to the Canceled branch", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createWaitNode("wait_1"),
        createRecorderNode("after_1", "After"),
        createRecorderNode("cleanup_1", "Cleanup"),
      ],
      edges: [
        lifecycleEdge("edge_started", "wait_1", "started"),
        { id: "edge_after", source: "wait_1", target: "after_1" },
        lifecycleEdge("edge_canceled", "cleanup_1", "canceled"),
      ],
    });

    await executeWorkflow(
      { ...cancelInput, graph },
      createInMemoryWorkflowRuntime({
        resumeEvent: { data: { signalType: "lifecycle-cancel" } },
        skipSleep: true,
      }),
      withCancelAnswers(store, [null, CANCEL]),
      actions
    );

    expect(Object.keys(recorded)).toEqual(["Cleanup"]);
    expect(store.callsOf("markWaitStateStatus")[0]?.status).toBe("cancelled");
    expect(store.callsOf("completeRun")[0]?.status).toBe("canceled");
  });
});
