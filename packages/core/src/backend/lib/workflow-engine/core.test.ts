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
import { executeWorkflowCore } from "./core";

// Mock the workflow-logging DB layer so withStepLogging calls are captured
// without requiring a real database connection.
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

describe("runtime action step logging", () => {
  const executeFn = mock<() => RuntimeActionResult>(() => ({
    success: true,
    data: { donorId: "d_123", name: "Test Donor" },
  }));

  beforeEach(() => {
    registerRuntimeAction({
      id: RUNTIME_ACTION_ID,
      label: "Test Runtime Action",
      description: "A test runtime action",
      execute: executeFn,
    });

    logStepStartDb.mockClear();
    logStepCompleteDb.mockClear();
    logWorkflowCompleteDb.mockClear();
    executeFn.mockClear();
  });

  afterEach(() => {
    unregisterRuntimeAction(RUNTIME_ACTION_ID);
  });

  it("executes a runtime action and returns its result", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createRuntimeActionNode("action_1"),
      ],
      edges: [{ id: "edge_1", source: "trigger_1", target: "action_1" }],
    });

    const result = await executeWorkflowCore({ graph });

    expect(result.success).toBe(true);
    expect(result.results.action_1?.success).toBe(true);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });

  it("creates step log entries for a runtime action when executionId is present", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createRuntimeActionNode("action_1", "Look Up Donor"),
      ],
      edges: [{ id: "edge_1", source: "trigger_1", target: "action_1" }],
    });

    await executeWorkflowCore({
      graph,
      executionId: "exec_123",
    });

    // withStepLogging should have called logStepStartDb for the runtime action node.
    // The trigger node also logs, so we expect at least 2 calls.
    const startCalls = logStepStartDb.mock.calls;
    const runtimeActionStartCall = startCalls.find(
      (call) => call[0].nodeId === "action_1"
    );
    expect(runtimeActionStartCall).toBeDefined();
    expect(runtimeActionStartCall?.[0].nodeName).toBe("Look Up Donor");
    expect(runtimeActionStartCall?.[0].executionId).toBe("exec_123");

    // And logStepCompleteDb should have been called for it too
    const completeCalls = logStepCompleteDb.mock.calls;
    const runtimeActionCompleteCall = completeCalls.find(
      (call) => call[0].logId === "mock-log-id" && call[0].status === "success"
    );
    expect(runtimeActionCompleteCall).toBeDefined();
  });

  it("logs step error when runtime action returns failure", async () => {
    executeFn.mockImplementation(() => ({
      success: false as const,
      error: { message: "Donor not found" },
    }));

    const graph = createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createRuntimeActionNode("action_1"),
      ],
      edges: [{ id: "edge_1", source: "trigger_1", target: "action_1" }],
    });

    const result = await executeWorkflowCore({
      graph,
      executionId: "exec_456",
    });

    expect(result.results.action_1?.success).toBe(false);

    const completeCalls = logStepCompleteDb.mock.calls;
    const errorLogCall = completeCalls.find(
      (call) =>
        call[0].status === "error" && call[0].error === "Donor not found"
    );
    expect(errorLogCall).toBeDefined();
  });

  it("does not create step logs when executionId is absent", async () => {
    const graph = createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createRuntimeActionNode("action_1"),
      ],
      edges: [{ id: "edge_1", source: "trigger_1", target: "action_1" }],
    });

    await executeWorkflowCore({ graph });

    // Without executionId, withStepLogging skips DB calls (logStepStart returns empty logId)
    // logStepStartDb should not be called for any node
    expect(logStepStartDb).not.toHaveBeenCalled();
  });
});
