import { beforeEach, describe, expect, it, vi } from "vitest";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";
import { createWorkflowActions } from "#src/backend/lib/extensions/workflow-actions";
import { Schema } from "effect";
import {
  createAction,
  type RuntimeActionExecuteInput,
  type RuntimeActionResult,
} from "@rova/shared/workflow/action-registry";
import { unknownRest } from "@rova/shared/types/schema";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import type { WorkflowNode } from "@rova/shared/workflow/types";
import { executeWorkflow } from "./core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "./recording-store";
import { createInMemoryWorkflowRuntime } from "./runtime";

const HOST_ACTION_ID = "test/host-action";
const PRODUCER_ACTION_ID = "test/producer-action";
const CONSUMER_ACTION_ID = "test/consumer-action";

/** What the host action under test answers with, per case. */
const executeFn = vi.fn<
  (input: RuntimeActionExecuteInput) => RuntimeActionResult
>(() => ({
  success: true,
  data: { donorId: "d_123", name: "Test Donor" },
}));

/** The resolved config the consumer action was handed, for the template cases. */
let capturedPayload: Record<string, unknown> = {};

function createTriggerNode(id: string): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: {},
    },
  };
}

function createHostActionNode(id: string, label = "Host Action"): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label,
      type: "action",
      config: {
        actionType: HOST_ACTION_ID,
      },
    },
  };
}

function createTriggerToActionGraph(actionLabel?: string) {
  return createSerializedWorkflowGraph({
    nodes: [
      createTriggerNode("trigger_1"),
      createHostActionNode("action_1", actionLabel),
    ],
    edges: [{ id: "edge_1", source: "trigger_1", target: "action_1" }],
  });
}

// The engine reaches an action's step and its label through the dispatch port
// the app builds, so every action these cases run is assembled here the way a
// host's own would be. The built-in two, Condition and Wait, ride in on the
// same assembly.
const actions = createWorkflowActions(
  assembleExtensions({
    actions: [
      createAction({
        id: HOST_ACTION_ID,
        label: "Test Host Action",
        description: "A test host action",
        schema: Schema.Struct({}),
        execute: executeFn,
      }),
      createAction({
        id: PRODUCER_ACTION_ID,
        label: "Producer",
        description: "Produces the output later nodes reference",
        schema: Schema.Struct({}),
        execute: () => ({
          success: true,
          data: {
            items: [{ name: "Widget" }, { name: "Gadget" }],
            customer: { name: "Ada" },
            count: 2,
          },
        }),
      }),
      createAction({
        id: CONSUMER_ACTION_ID,
        label: "Consumer",
        description: "Records the config it was handed",
        // Every case hands this action a config of its own, so the shape stays
        // open: a declared field list would decode the keys under test away.
        schema: Schema.StructWithRest(Schema.Struct({}), unknownRest),
        execute: ({ payload }) => {
          capturedPayload = payload;
          return { success: true, data: {} };
        },
      }),
    ],
  }),
  stubRovaRuntime()
);

describe("host action execution", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    executeFn.mockClear();
    executeFn.mockImplementation(() => ({
      success: true,
      data: { donorId: "d_123", name: "Test Donor" },
    }));
  });

  it("executes a host action and returns its result", async () => {
    const result = await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        executionId: "exec_123",
        workflowId: "workflow_1",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.action_1?.success).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  // The context is how an author learns which node their action is running as, and
  // the node name is the label off the saved graph rather than anything the action
  // declared.
  it("passes the resolved node name into the action's context", async () => {
    await executeWorkflow(
      {
        graph: createTriggerToActionGraph("Look Up Donor"),
        executionId: "exec_123",
        workflowId: "workflow_1",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(executeFn.mock.calls[0]?.[0]).toMatchObject({
      context: {
        executionId: "exec_123",
        nodeId: "action_1",
        nodeName: "Look Up Donor",
      },
    });
  });

  it("reports a failing host action as a failed node result", async () => {
    executeFn.mockImplementation(() => ({
      success: false as const,
      error: { message: "Donor not found" },
    }));

    const result = await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        executionId: "exec_456",
        workflowId: "workflow_1",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.action_1?.success).toBe(false);
    expect(result.results.action_1?.error).toBe("Donor not found");
  });

  // A stored graph naming an action nothing assembled -- an id from a deleted
  // integration, a typo, a build served by a different Rova than the one that
  // saved it -- fails the node by name rather than the run. The message lists
  // the built-ins the surface still ships, which is Condition and Wait now that
  // neither HTTP nor database work rides in on an empty assembly.
  it("fails a node naming an action nothing assembled", async () => {
    const result = await executeWorkflow(
      {
        graph: createSerializedWorkflowGraph({
          nodes: [
            createTriggerNode("trigger_1"),
            {
              id: "action_1",
              type: "action",
              position: { x: 100, y: 100 },
              data: {
                label: "Ghost Action",
                type: "action",
                config: { actionType: "nobody/knows" },
              },
            },
          ],
          edges: [{ id: "edge_1", source: "trigger_1", target: "action_1" }],
        }),
        executionId: "exec_789",
        workflowId: "workflow_1",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.action_1?.success).toBe(false);
    expect(result.results.action_1?.error).toContain(
      'Unknown action type: "nobody/knows"'
    );
    expect(result.results.action_1?.error).toContain("Condition, Wait");
  });
});

describe("run persistence through the store port", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    executeFn.mockClear();
    executeFn.mockImplementation(() => ({ success: true, data: { ok: true } }));
  });

  it("writes the terminal run record and its timeline event on success", async () => {
    await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        executionId: "exec_success",
        workflowId: "workflow_success",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    const completions = store.callsOf("completeRun");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.executionId).toBe("exec_success");
    expect(completions[0]?.status).toBe("completed");

    const audits = store.callsOf("recordAuditEvent");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.eventType).toBe("run_completed");
    expect(audits[0]?.workflowId).toBe("workflow_success");
    expect(audits[0]?.message).toBe("Run completed successfully");
  });

  // The rows every node leaves behind are the engine's, written through the same
  // port as the wait's: a plugin's action, a host's action and the entry node all
  // log the same way, and a step author writes none of it.
  it("opens and closes a run-log row for every node it runs", async () => {
    await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        triggerInput: { donorId: "d_123" },
        executionId: "exec_logs",
        workflowId: "workflow_logs",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(store.callsOf("startStepLog")).toEqual([
      {
        executionId: "exec_logs",
        nodeId: "trigger_1",
        nodeName: "Trigger",
        nodeType: "trigger",
        input: { triggerData: { donorId: "d_123" } },
      },
      {
        executionId: "exec_logs",
        nodeId: "action_1",
        nodeName: "Host Action",
        nodeType: HOST_ACTION_ID,
        // The three keys the engine's dispatch owns are stripped, so the row
        // shows what the node was configured with and nothing else.
        input: {},
      },
    ]);

    expect(store.callsOf("completeStepLog")).toEqual([
      expect.objectContaining({
        logId: "log_1",
        status: "success",
        output: { donorId: "d_123" },
      }),
      expect.objectContaining({
        logId: "log_2",
        status: "success",
        output: { ok: true },
      }),
    ]);
  });

  it("closes a failed node's row with the reason it gave", async () => {
    executeFn.mockImplementation(() => ({
      success: false as const,
      error: { message: "Donor not found" },
    }));

    await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        executionId: "exec_log_failure",
        workflowId: "workflow_log_failure",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(store.callsOf("completeStepLog")[1]).toMatchObject({
      logId: "log_2",
      status: "error",
      output: { message: "Donor not found" },
      error: "Donor not found",
    });
  });

  it("marks the run failed when a node fails", async () => {
    executeFn.mockImplementation(() => ({
      success: false as const,
      error: { message: "boom" },
    }));

    await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        executionId: "exec_failure",
        workflowId: "workflow_failure",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    const completions = store.callsOf("completeRun");
    expect(completions[0]?.status).toBe("failed");
    expect(completions[0]?.error).toBe("boom");
    expect(store.callsOf("recordAuditEvent")[0]?.eventType).toBe("run_failed");
  });

  it("labels a test-mode run in its timeline message", async () => {
    await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        executionId: "exec_test_mode",
        workflowId: "workflow_test_mode",
        runMode: "test",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(store.callsOf("recordAuditEvent")[0]?.message).toBe(
      "Test mode completed successfully"
    );
  });

  /**
   * A store that answers one of its two run-log writes with a rejection, the
   * way an unreachable database does.
   */
  function storeRefusing(
    method: "startStepLog" | "completeStepLog"
  ): RecordingWorkflowStore {
    const refusal = () => Promise.reject(new Error("run log unreachable"));
    return { ...store, [method]: refusal };
  }

  // The node's work is an SMS, an email, a POST. This whole call sits inside the
  // memoized step, so a throw while recording the success would discard the
  // result the runtime was about to store and send the message a second time to
  // record the first.
  it("keeps a node's result when the write closing its row fails", async () => {
    const result = await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        executionId: "exec_close_refused",
        workflowId: "workflow_close_refused",
      },
      createInMemoryWorkflowRuntime(),
      storeRefusing("completeStepLog"),
      actions
    );

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.results.action_1?.data).toEqual({
      success: true,
      data: { ok: true },
    });
    expect(store.callsOf("completeRun")[0]?.status).toBe("completed");
  });

  // The opposite half of the same policy: nothing has happened when the row is
  // opened, so a refused write there fails the node and Inngest's retry of it
  // costs one wasted call.
  it("fails a node when the write opening its row fails", async () => {
    const result = await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        executionId: "exec_open_refused",
        workflowId: "workflow_open_refused",
      },
      createInMemoryWorkflowRuntime(),
      storeRefusing("startStepLog"),
      actions
    );

    expect(executeFn).toHaveBeenCalledTimes(0);
    expect(result.success).toBe(false);
    expect(result.results.trigger_1?.error).toBe("run log unreachable");
  });

  it("persists nothing when no store is injected", async () => {
    const result = await executeWorkflow(
      {
        graph: createTriggerToActionGraph(),
        executionId: "exec_no_store",
        workflowId: "workflow_no_store",
      },
      undefined,
      undefined,
      actions
    );

    // The engine's default store is the noop adapter: the run still executes,
    // it just leaves no trace.
    expect(result.success).toBe(true);
    expect(store.calls).toHaveLength(0);
  });
});

/**
 * Template tokens are minted by the editor's autocomplete, which offers an
 * array element as `field[0].child`. These tests pin the live engine path so an
 * offered token resolves to the value a user sees in the picker.
 */
describe("template resolution into action config", () => {
  beforeEach(() => {
    capturedPayload = {};
  });

  async function runWithConsumerConfig(
    config: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        {
          id: "action_1",
          type: "action",
          position: { x: 100, y: 100 },
          data: {
            label: "Producer",
            type: "action",
            config: { actionType: PRODUCER_ACTION_ID },
          },
        },
        {
          id: "action_2",
          type: "action",
          position: { x: 200, y: 200 },
          data: {
            label: "Consumer",
            type: "action",
            config: { actionType: CONSUMER_ACTION_ID, ...config },
          },
        },
      ],
      edges: [
        { id: "edge_1", source: "trigger_1", target: "action_1" },
        { id: "edge_2", source: "action_1", target: "action_2" },
      ],
    });

    await executeWorkflow(
      {
        graph,
        executionId: "exec_templates",
        workflowId: "workflow_templates",
      },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions
    );

    return capturedPayload;
  }

  it("resolves the array element path the autocomplete offers", async () => {
    const payload = await runWithConsumerConfig({
      subject: "{{@action_1:Producer.items[0].name}}",
    });

    expect(payload.subject).toBe("Widget");
  });

  it("resolves an array element past the first one", async () => {
    const payload = await runWithConsumerConfig({
      subject: "Order for {{@action_1:Producer.items[1].name}}",
    });

    expect(payload.subject).toBe("Order for Gadget");
  });

  it("still resolves a plain dotted path", async () => {
    const payload = await runWithConsumerConfig({
      subject: "{{@action_1:Producer.customer.name}}",
    });

    expect(payload.subject).toBe("Ada");
  });

  it("resolves an out-of-range index to an empty string", async () => {
    const payload = await runWithConsumerConfig({
      subject: "{{@action_1:Producer.items[5].name}}",
    });

    expect(payload.subject).toBe("");
  });

  it("resolves a bracket segment on a non-array to an empty string", async () => {
    const payload = await runWithConsumerConfig({
      subject: "{{@action_1:Producer.count[0]}}",
    });

    expect(payload.subject).toBe("");
  });
});
