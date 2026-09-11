/**
 * The Canceled outlet, as the engine walks it.
 *
 * A cancellation is a routed continuation (ADR-0007): the authority is a flag on
 * the execution row, and the engine reads it at each node boundary inside a step.
 * These cases drive that flag through the store port and pin what a run does with
 * it -- which outlet it leaves the entry node by, what the branch can address, and
 * the status the run ends on.
 */

import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseError } from "#src/backend/lib/effect/database";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { unknownRest } from "@wfgraph/shared/types/schema";
import { defineAction } from "#src/backend/extensions/define-action";
import {
  type ConditionModel,
  compileConditionModel,
  EVENT_NAME_FIELD_PATH,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import type { PendingCancel, WorkflowStore } from "#src/backend/engine/store";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";

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
  stubWfGraphRuntime()
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
    readPendingCancel: (executionId) =>
      Effect.gen(function* () {
        yield* store.readPendingCancel(executionId);
        const answer = answers[reads] ?? null;
        reads += 1;
        return answer;
      }),
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
          startEvents: ["app/appointment.created"],
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

  // Which Cancel Event claimed the run is the only thing telling two of them
  // apart, because the Canceled outlet is one outlet however many Events feed
  // it.
  it("offers the canceling Event's name to a Condition on the branch", async () => {
    const model: ConditionModel = {
      version: 2,
      groupLogic: "and",
      groups: [
        {
          id: "group-1",
          logic: "and",
          conditions: [
            {
              id: "condition-1",
              field: EVENT_NAME_FIELD_PATH,
              fieldType: "string",
              operator: "equals",
              value: "billing/subscription.canceled",
            },
          ],
        },
      ],
    };

    const compiled = compileConditionModel(model);
    if (!compiled.valid) {
      throw new Error(compiled.error);
    }

    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createProducerNode("producer_1", "Producer"),
        {
          id: "which_1",
          type: "action",
          position: { x: 0, y: 0 },
          data: {
            label: "Which Event",
            type: "action",
            config: {
              actionType: "Condition",
              condition: compiled.expression,
              conditionModel: serializeConditionModel(model),
            },
          },
        },
        createRecorderNode("canceled_1", "Canceled"),
        createRecorderNode("rescheduled_1", "Rescheduled"),
      ],
      edges: [
        lifecycleEdge("edge_started", "producer_1", "started"),
        lifecycleEdge("edge_canceled", "which_1", "canceled"),
        {
          id: "edge_true",
          source: "which_1",
          sourceHandle: "true",
          target: "canceled_1",
        },
        {
          id: "edge_false",
          source: "which_1",
          sourceHandle: "false",
          target: "rescheduled_1",
        },
      ],
    });

    await executeWorkflow(
      { ...cancelInput, graph },
      createInMemoryWorkflowRuntime(),
      withCancelAnswers(store, [null, CANCEL]),
      actions
    );

    expect(Object.keys(recorded)).toEqual(["Canceled"]);

    // The same graph under the other Cancel Event takes the other branch, which
    // is what shows the name reaching the rule rather than the rule reading
    // something that happens to be true.
    recorded = {};
    await executeWorkflow(
      { ...cancelInput, graph, executionId: "exec_cancel_other" },
      createInMemoryWorkflowRuntime(),
      withCancelAnswers(createRecordingWorkflowStore(), [
        null,
        { ...CANCEL, eventName: "billing/subscription.rescheduled" },
      ]),
      actions
    );

    expect(Object.keys(recorded)).toEqual(["Rescheduled"]);
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

  it("honors a pending cancel when the active node fails through the error channel", async () => {
    const refusingStore: RecordingWorkflowStore = {
      ...store,
      startStepLog: (input) =>
        input.nodeId === "producer_1"
          ? Effect.fail(
              new DatabaseError({ cause: new Error("run log unreachable") })
            )
          : store.startStepLog(input),
    };

    const result = await executeWorkflow(
      cancelInput,
      createInMemoryWorkflowRuntime(),
      withCancelAnswers(refusingStore, [null, CANCEL]),
      actions
    );

    expect(Object.keys(recorded)).toEqual(["Cleanup"]);
    expect(result.results.after_1).toBeUndefined();
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
      }),
      withCancelAnswers(store, [null, CANCEL]),
      actions
    );

    expect(Object.keys(recorded)).toEqual(["Cleanup"]);
    expect(store.callsOf("markWaitStateStatus")[0]?.status).toBe("cancelled");
    expect(store.callsOf("completeRun")[0]?.status).toBe("canceled");
  });
});

/**
 * Stamps a Cancel claim on the recording store's execution row, as a Cancel
 * Event arriving at that moment does. The boundary read of the recording store
 * still answers null, which is the truth for a claim landing after the last
 * node's boundary read.
 */
function landCancelClaim(store: RecordingWorkflowStore) {
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
function claimAtTerminalWrite(
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
function cancelledAudits(store: RecordingWorkflowStore) {
  return store
    .callsOf("recordAuditEvent")
    .filter((event) => event.eventType === "run_cancelled");
}

/**
 * How many run-log rows the run opened for one node. The row opens inside a
 * memoized step, so it counts how often the node ran across every replay. A
 * handler body is not a step (ADR-0009) and runs again on each replay, so the
 * handler's own calls cannot tell a replay from a second run.
 */
function rowsOpenedFor(store: RecordingWorkflowStore, nodeId: string) {
  return store.callsOf("startStepLog").filter((row) => row.nodeId === nodeId)
    .length;
}

describe("a Cancel claim that lands after the last boundary read", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    recorded = {};
  });

  it("runs the Canceled outlet once before recording canceled when the claim lands before the outcome read", async () => {
    const run = await driveWithReplay((runtime) =>
      executeWorkflow(
        cancelInput,
        runtime,
        claimBeforeOutcomeRead(store),
        actions
      )
    );

    expect(run.value.status).toBe("canceled");
    // The Started branch finished before the claim, so After ran too.
    expect(rowsOpenedFor(store, "after_1")).toBe(1);
    expect(rowsOpenedFor(store, "cleanup_1")).toBe(1);
    expect(recorded.Cleanup).toMatchObject({
      reason: "customer left",
      orderId: "o_1",
    });
    expect(store.callsOf("completeRun").map((call) => call.status)).toEqual([
      "canceled",
    ]);
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
    const run = await driveWithReplay((runtime) =>
      executeWorkflow(
        cancelInput,
        runtime,
        claimAtTerminalWrite(store),
        actions
      )
    );

    expect(run.value.status).toBe("canceled");
    expect(rowsOpenedFor(store, "after_1")).toBe(1);
    expect(rowsOpenedFor(store, "cleanup_1")).toBe(1);
    expect(recorded.Cleanup).toMatchObject({ reason: "customer left" });
    expect(store.callsOf("completeRun").map((call) => call.status)).toEqual([
      "completed",
      "canceled",
    ]);
    expect(store.terminationState?.status).toBe("canceled");
    expect(cancelledAudits(store)).toEqual([
      expect.objectContaining({
        message: "Run canceled at the Canceled outlet",
      }),
    ]);
    expect(
      store
        .callsOf("recordAuditEvent")
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

  it("runs the Canceled outlet once when a failed terminal write is retried into the claim", async () => {
    const memo = new Map<string, unknown>();
    const lateStore = claimAtTerminalWrite(
      store,
      new DatabaseError({ cause: new Error("terminal unavailable") })
    );

    await expect(
      executeWorkflow(
        cancelInput,
        createInMemoryWorkflowRuntime({ memo }),
        lateStore,
        actions
      )
    ).rejects.toThrow("terminal unavailable");
    expect(memo.has("workflow-run-completed")).toBe(false);
    expect(rowsOpenedFor(store, "cleanup_1")).toBe(0);

    // Inngest retries the failed step: the body runs again over the same memo.
    const retried = await executeWorkflow(
      cancelInput,
      createInMemoryWorkflowRuntime({ memo }),
      lateStore,
      actions
    );

    expect(retried.status).toBe("canceled");
    expect(rowsOpenedFor(store, "cleanup_1")).toBe(1);

    // One more replay over the finished memo repeats nothing.
    const replayed = await executeWorkflow(
      cancelInput,
      createInMemoryWorkflowRuntime({ memo }),
      lateStore,
      actions
    );

    expect(replayed.status).toBe("canceled");
    expect(rowsOpenedFor(store, "after_1")).toBe(1);
    expect(rowsOpenedFor(store, "cleanup_1")).toBe(1);
    expect(store.callsOf("completeRun").map((call) => call.status)).toEqual([
      "completed",
      "canceled",
    ]);
    expect(cancelledAudits(store)).toEqual([
      expect.objectContaining({
        message: "Run canceled at the Canceled outlet",
      }),
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

    const run = await driveWithReplay((runtime) =>
      executeWorkflow(
        { ...cancelInput, graph },
        runtime,
        claimAtTerminalWrite(store),
        actions
      )
    );

    expect(run.value.status).toBe("canceled");
    // The Wait's due time is taken from the wall clock, so the run's clock can
    // land a millisecond short of the full hour.
    expect(run.elapsedMs).toBeGreaterThan(59 * 60 * 1000);
    expect(run.elapsedMs).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(rowsOpenedFor(store, "cleanup_1")).toBe(1);
    expect(recorded.Cleanup).toBeDefined();
    expect(store.callsOf("createWaitState")).toHaveLength(1);
    expect(store.callsOf("completeRun").map((call) => call.status)).toEqual([
      "completed",
      "canceled",
    ]);
    expect(cancelledAudits(store)).toHaveLength(1);
  });
});
