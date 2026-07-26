import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  LogStepCompleteParams,
  LogStepStartParams,
} from "@/backend/lib/workflow-logging";
import {
  type RuntimeActionResult,
  registerRuntimeAction,
  unregisterRuntimeAction,
} from "@/shared/workflow/action-registry";
import { createSerializedWorkflowGraph } from "@/shared/workflow/graph";
import type { WorkflowNode } from "@/shared/workflow/types";
import { executeWorkflow } from "./core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "./recording-store";
import { createInMemoryWorkflowRuntime } from "./runtime";

// Per-action step logs are still written by step-handler's withStepLogging,
// which plugin steps call themselves and which has not moved behind the
// WorkflowStore port. These stubs exist only to keep that path off a real
// database - everything the engine itself persists is asserted through the
// recording store below.
const logStepStartDb = mock<
  (params: LogStepStartParams) => Promise<{ logId: string; startTime: number }>
>(() => Promise.resolve({ logId: "mock-log-id", startTime: Date.now() }));
const logStepCompleteDb = mock<
  (params: LogStepCompleteParams) => Promise<void>
>(() => Promise.resolve());
const logWorkflowCompleteDb = mock(() => Promise.resolve());

mock.module("@/backend/lib/workflow-logging", () => ({
  logStepStartDb,
  logStepCompleteDb,
  logWorkflowCompleteDb,
}));

const RUNTIME_ACTION_ID = "test/runtime-action";

function createTriggerNode(id: string): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: { triggerType: "Trigger" },
    },
  };
}

function createRuntimeActionNode(
  id: string,
  label = "Runtime Action"
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label,
      type: "action",
      config: {
        actionType: RUNTIME_ACTION_ID,
      },
    },
  };
}

function createTriggerToActionGraph(actionLabel?: string) {
  return createSerializedWorkflowGraph({
    nodes: [
      createTriggerNode("trigger_1"),
      createRuntimeActionNode("action_1", actionLabel),
    ],
    edges: [{ id: "edge_1", source: "trigger_1", target: "action_1" }],
  });
}

describe("runtime action execution", () => {
  const executeFn = mock<() => RuntimeActionResult>(() => ({
    success: true,
    data: { donorId: "d_123", name: "Test Donor" },
  }));
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    registerRuntimeAction({
      id: RUNTIME_ACTION_ID,
      label: "Test Runtime Action",
      description: "A test runtime action",
      execute: executeFn,
    });

    store = createRecordingWorkflowStore();
    logStepStartDb.mockClear();
    logStepCompleteDb.mockClear();
    logWorkflowCompleteDb.mockClear();
    executeFn.mockClear();
    executeFn.mockImplementation(() => ({
      success: true,
      data: { donorId: "d_123", name: "Test Donor" },
    }));
  });

  afterEach(() => {
    unregisterRuntimeAction(RUNTIME_ACTION_ID);
  });

  it("executes a runtime action and returns its result", async () => {
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

  it("passes the resolved node name into the action's step context", async () => {
    await executeWorkflow(
      {
        graph: createTriggerToActionGraph("Look Up Donor"),
        executionId: "exec_123",
        workflowId: "workflow_1",
      },
      createInMemoryWorkflowRuntime(),
      store
    );

    const startCall = logStepStartDb.mock.calls.find(
      (call) => call[0].nodeId === "action_1"
    );
    expect(startCall?.[0].nodeName).toBe("Look Up Donor");
    expect(startCall?.[0].executionId).toBe("exec_123");
  });

  it("reports a failing runtime action as a failed node result", async () => {
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

describe("run persistence through the store port", () => {
  const executeFn = mock<() => RuntimeActionResult>(() => ({
    success: true,
    data: { ok: true },
  }));
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    registerRuntimeAction({
      id: RUNTIME_ACTION_ID,
      label: "Test Runtime Action",
      description: "A test runtime action",
      execute: executeFn,
    });
    store = createRecordingWorkflowStore();
    executeFn.mockClear();
    executeFn.mockImplementation(() => ({ success: true, data: { ok: true } }));
  });

  afterEach(() => {
    unregisterRuntimeAction(RUNTIME_ACTION_ID);
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
    expect(completions[0]?.status).toBe("success");

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
    expect(completions[0]?.status).toBe("error");
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
