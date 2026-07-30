import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  clearExtensions,
  configureExtensions,
} from "#src/backend/lib/extensions/current";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
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
      store
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
      store
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
      store
    );

    expect(result.results.action_1?.success).toBe(false);
    expect(result.results.action_1?.error).toBe("Donor not found");
  });
});

// The engine reads the assembled surface for an action's step and its label, and
// `getExtensions` throws outside an app rather than answering nothing, so every
// action these cases run is assembled here the way a host's own would be. The
// built-in four ride in on the same assembly.
beforeAll(() => {
  configureExtensions(
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
    })
  );
});

afterAll(() => {
  clearExtensions();
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
      store
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
      store
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
      store
    );

    expect(store.callsOf("recordAuditEvent")[0]?.message).toBe(
      "Test mode completed successfully"
    );
  });

  it("persists nothing when no store is injected", async () => {
    const result = await executeWorkflow({
      graph: createTriggerToActionGraph(),
      executionId: "exec_no_store",
      workflowId: "workflow_no_store",
    });

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
      createRecordingWorkflowStore()
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
