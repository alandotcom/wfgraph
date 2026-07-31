import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ActionRunContext,
  defineAction,
} from "#src/backend/extensions/define-action";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { defineStep } from "#src/backend/extensions/steps/define-step";
import { Effect, Schema } from "effect";
import { unknownRest } from "@rova/shared/types/schema";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import type { WorkflowNode } from "@rova/shared/graph/types";
import { executeWorkflow } from "./core";
import { executionData, executionError } from "./contracts";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "./recording-store";
import { createInMemoryWorkflowRuntime } from "./runtime";

const HOST_ACTION_ID = "test/host-action";
const PRODUCER_ACTION_ID = "test/producer-action";
const CONSUMER_ACTION_ID = "test/consumer-action";
const NOTIFY_ACTION_ID = "notify/send";

/** What the host action under test answers with, per case. */
const handlerFn = vi.fn<
  (input: {
    payload: Record<string, unknown>;
    context: ActionRunContext;
  }) => Record<string, unknown>
>(() => ({ donorId: "d_123", name: "Test Donor" }));

/** The resolved config the consumer action was handed, for the template cases. */
let capturedPayload: Record<string, unknown> = {};

/** The decoded config the notify step was handed, for the literal-field cases. */
let capturedStepInput: Record<string, unknown> = {};

/**
 * An integration whose step declares one templated field and one literal one,
 * which is the shape resend and twilio give their test destinations.
 */
const notify = defineIntegration({
  type: "notify",
  label: "Notify",
  description: "A step with a literal config field",
  credentials: [],
  actions: {
    send: defineStep({
      label: "Send Notification",
      description: "Records the config it was handed",
      category: "Notify",
      input: Schema.Struct({
        subject: Schema.optionalKey(Schema.String),
        testEmailTo: Schema.optionalKey(Schema.String),
      }),
      output: Schema.Struct({
        ok: Schema.Boolean.annotate({ description: "Whether it ran" }),
      }),
      configFields: [
        { key: "subject", label: "Subject", type: "template-input" },
        {
          key: "testEmailTo",
          label: "Test Email Address",
          type: "text",
          literal: true,
        },
      ],
      handler: Effect.fn(function* (input) {
        capturedStepInput = { ...input };
        return yield* Effect.succeed({ ok: true });
      }),
    }),
  },
});

function createLifecycleNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
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

function createLifecycleToActionGraph(actionLabel?: string) {
  return createSerializedWorkflowGraph({
    nodes: [
      createLifecycleNode("lifecycle_1"),
      createHostActionNode("action_1", actionLabel),
    ],
    edges: [
      {
        id: "edge_1",
        source: "lifecycle_1",
        sourceHandle: "started",
        target: "action_1",
      },
    ],
  });
}

// The engine reaches an action's step and its label through the dispatch port
// the app builds, so every action these cases run is assembled here the way a
// host's own would be. The built-in two, Condition and Wait, ride in on the
// same assembly.
const actions = createWorkflowActions(
  assembleExtensions({
    actions: [
      defineAction({
        id: HOST_ACTION_ID,
        label: "Test Host Action",
        description: "A test host action",
        input: Schema.Struct({}),
        handler: handlerFn,
      }),
      defineAction({
        id: PRODUCER_ACTION_ID,
        label: "Producer",
        description: "Produces the output later nodes reference",
        input: Schema.Struct({}),
        handler: () => ({
          items: [{ name: "Widget" }, { name: "Gadget" }],
          customer: { name: "Ada" },
          count: 2,
        }),
      }),
      defineAction({
        id: CONSUMER_ACTION_ID,
        label: "Consumer",
        description: "Records the config it was handed",
        // Every case hands this action a config of its own, so the shape stays
        // open: a declared field list would decode the keys under test away.
        input: Schema.StructWithRest(Schema.Struct({}), unknownRest),
        handler: ({ payload }) => {
          capturedPayload = payload;
          return {};
        },
      }),
    ],
    integrations: [notify],
  }),
  stubRovaRuntime()
);

describe("host action execution", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    handlerFn.mockClear();
    handlerFn.mockImplementation(() => ({
      donorId: "d_123",
      name: "Test Donor",
    }));
  });

  it("executes a host action and returns its result", async () => {
    const result = await executeWorkflow(
      {
        graph: createLifecycleToActionGraph(),
        executionId: "exec_123",
        workflowId: "workflow_1",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(true);
    expect(result.results.action_1?.success).toBe(true);
    expect(handlerFn).toHaveBeenCalledTimes(1);
  });

  // The context is how an author learns which node their action is running as, and
  // the node name is the label off the saved graph rather than anything the action
  // declared.
  it("passes the resolved node name into the action's context", async () => {
    await executeWorkflow(
      {
        graph: createLifecycleToActionGraph("Look Up Donor"),
        executionId: "exec_123",
        workflowId: "workflow_1",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(handlerFn.mock.calls[0]?.[0]).toMatchObject({
      context: {
        executionId: "exec_123",
        nodeId: "action_1",
        nodeName: "Look Up Donor",
      },
    });
  });

  it("reports a failing host action as a failed node result", async () => {
    handlerFn.mockImplementation(() => {
      throw new Error("Donor not found");
    });

    const result = await executeWorkflow(
      {
        graph: createLifecycleToActionGraph(),
        executionId: "exec_456",
        workflowId: "workflow_1",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.action_1?.success).toBe(false);
    expect(executionError(result.results.action_1)).toBe("Donor not found");
  });

  // A stored graph naming an action nothing assembled -- an id from a deleted
  // integration, a typo, a build served by a different Rova than the one that
  // saved it -- fails the node by name rather than the run. The message lists
  // the two ids the engine ships itself, which it knows without asking the
  // dispatch port: a surface holding nothing would otherwise make the sentence
  // read as though the build shipped no built-ins either.
  it("fails a node naming an action nothing assembled", async () => {
    const result = await executeWorkflow(
      {
        graph: createSerializedWorkflowGraph({
          nodes: [
            createLifecycleNode("lifecycle_1"),
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
          edges: [
            {
              id: "edge_1",
              source: "lifecycle_1",
              sourceHandle: "started",
              target: "action_1",
            },
          ],
        }),
        executionId: "exec_789",
        workflowId: "workflow_1",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.results.action_1?.success).toBe(false);
    expect(executionError(result.results.action_1)).toContain(
      'Unknown action type: "nobody/knows"'
    );
    expect(executionError(result.results.action_1)).toContain(
      "Condition, Wait"
    );
  });
});

describe("run persistence through the store port", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    handlerFn.mockClear();
    handlerFn.mockImplementation(() => ({ ok: true }));
  });

  it("writes the terminal run record and its timeline event on success", async () => {
    await executeWorkflow(
      {
        graph: createLifecycleToActionGraph(),
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
        graph: createLifecycleToActionGraph(),
        startPayload: { donorId: "d_123" },
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
        nodeId: "lifecycle_1",
        nodeName: "Lifecycle",
        nodeType: "lifecycle",
        input: { lifecycleData: { donorId: "d_123" } },
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
    handlerFn.mockImplementation(() => {
      throw new Error("Donor not found");
    });

    await executeWorkflow(
      {
        graph: createLifecycleToActionGraph(),
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
    handlerFn.mockImplementation(() => {
      throw new Error("boom");
    });

    await executeWorkflow(
      {
        graph: createLifecycleToActionGraph(),
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
        graph: createLifecycleToActionGraph(),
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
        graph: createLifecycleToActionGraph(),
        executionId: "exec_close_refused",
        workflowId: "workflow_close_refused",
      },
      createInMemoryWorkflowRuntime(),
      storeRefusing("completeStepLog"),
      actions
    );

    expect(handlerFn).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(executionData(result.results.action_1)).toEqual({
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
        graph: createLifecycleToActionGraph(),
        executionId: "exec_open_refused",
        workflowId: "workflow_open_refused",
      },
      createInMemoryWorkflowRuntime(),
      storeRefusing("startStepLog"),
      actions
    );

    expect(handlerFn).toHaveBeenCalledTimes(0);
    expect(result.success).toBe(false);
    expect(executionError(result.results.lifecycle_1)).toBe(
      "run log unreachable"
    );
  });

  // Every seam failure the backend answers with is a `Schema.TaggedErrorClass`,
  // which carries its text on `cause` and leaves `.message` empty. A row closed
  // with that message alone is a red node with no sentence beside it.
  it("closes a node's row with a sentence when the error carries an empty message", async () => {
    class DatabaseError extends Error {
      constructor(cause: unknown) {
        super("", { cause });
        this.name = "DatabaseError";
      }
    }

    handlerFn.mockImplementation(() => {
      throw new DatabaseError(new Error("connection terminated"));
    });

    await executeWorkflow(
      {
        graph: createLifecycleToActionGraph(),
        executionId: "exec_tagged_failure",
        workflowId: "workflow_tagged_failure",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    const closed = store
      .callsOf("completeStepLog")
      .find((call) => call.status === "error");
    expect(closed?.error).toBe("DatabaseError: connection terminated");
  });

  // The word in an error's text says nothing about why a run ended. A cancel is
  // the flag on the execution row, which this run never had set.
  it("records a failure whose text says 'cancelled' as failed", async () => {
    handlerFn.mockImplementation(() => {
      throw new Error("Subscription cancelled by the provider");
    });

    const result = await executeWorkflow(
      {
        graph: createLifecycleToActionGraph(),
        executionId: "exec_cancel_worded",
        workflowId: "workflow_cancel_worded",
      },
      createInMemoryWorkflowRuntime(),
      store,
      actions
    );

    expect(result.success).toBe(false);
    expect(executionError(result.results.action_1)).toBe(
      "Subscription cancelled by the provider"
    );
    expect(store.callsOf("completeRun")[0]?.status).toBe("failed");
    expect(
      store.callsOf("recordAuditEvent").map((call) => call.eventType)
    ).toContain("run_failed");
  });

  /**
   * A runtime that refuses the terminal step, which is what puts a run on the
   * fatal path where `recordRunFailed` writes.
   */
  function runtimeRefusingTerminalStep() {
    const runtime = createInMemoryWorkflowRuntime();
    return {
      ...runtime,
      step: <T>(stepId: string, fn: () => Promise<T>): Promise<T> =>
        stepId === "workflow-run-completed"
          ? Promise.reject(new Error("terminal write refused"))
          : runtime.step(stepId, fn),
    };
  }

  // A superseded run reaches this path, and its row stays `superseded` because
  // `completeRun` refuses the write. Announcing the failure anyway would put a
  // last word on the timeline that contradicts the row.
  it("announces a fatal failure only when the terminal write owned it", async () => {
    const displaced: RecordingWorkflowStore = {
      ...store,
      completeRun: (input) => {
        store.completeRun(input);
        return Promise.resolve(false);
      },
    };

    await executeWorkflow(
      {
        graph: createLifecycleToActionGraph(),
        executionId: "exec_displaced",
        workflowId: "workflow_displaced",
      },
      runtimeRefusingTerminalStep(),
      displaced,
      actions
    );

    expect(store.callsOf("completeRun")).toHaveLength(1);
    expect(
      store.callsOf("recordAuditEvent").map((call) => call.eventType)
    ).not.toContain("run_failed");
  });

  it("announces a fatal failure that did own the terminal write", async () => {
    await executeWorkflow(
      {
        graph: createLifecycleToActionGraph(),
        executionId: "exec_fatal",
        workflowId: "workflow_fatal",
      },
      runtimeRefusingTerminalStep(),
      store,
      actions
    );

    expect(
      store.callsOf("recordAuditEvent").map((call) => call.eventType)
    ).toContain("run_failed");
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
    capturedStepInput = {};
  });

  /**
   * Run a producer node followed by the node under test, so the second node's
   * config has an upstream output to reference.
   */
  async function runDownstreamNode(
    actionType: string,
    config: Record<string, unknown>,
    runMode: "live" | "test" = "live"
  ): Promise<void> {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
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
            config: { actionType, ...config },
          },
        },
      ],
      edges: [
        {
          id: "edge_1",
          source: "lifecycle_1",
          sourceHandle: "started",
          target: "action_1",
        },
        { id: "edge_2", source: "action_1", target: "action_2" },
      ],
    });

    await executeWorkflow(
      {
        graph,
        executionId: "exec_templates",
        workflowId: "workflow_templates",
        runMode,
      },
      createInMemoryWorkflowRuntime(),
      createRecordingWorkflowStore(),
      actions
    );
  }

  async function runWithConsumerConfig(
    config: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    await runDownstreamNode(CONSUMER_ACTION_ID, config);
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

  // The flag is unconditional, so both run modes are covered: a test
  // destination is an address a person typed, and a run steering it from its own
  // payload would send the test message wherever the payload pointed.
  it.each(["live", "test"] as const)(
    "hands a literal field to the step as authored in %s mode",
    async (runMode) => {
      await runDownstreamNode(
        NOTIFY_ACTION_ID,
        {
          subject: "{{@action_1:Producer.customer.name}}",
          testEmailTo: "{{@action_1:Producer.customer.name}}",
        },
        runMode
      );

      expect(capturedStepInput.subject).toBe("Ada");
      expect(capturedStepInput.testEmailTo).toBe(
        "{{@action_1:Producer.customer.name}}"
      );
    }
  );
});
