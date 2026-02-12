import { beforeEach, describe, expect, it, mock, vi } from "bun:test";
import { InngestTestEngine } from "@inngest/test";
import type { WorkflowExecutionRuntime } from "../workflow-executor.workflow";

mock.module("../workflow-executor.workflow", () => ({
  executeWorkflow: vi.fn(),
}));

const { executeWorkflow } = await import("../workflow-executor.workflow");
const { createWorkflowRunRequestedFunction, createWorkflowTriggerExpression } =
  await import("./workflow-function");

const executeWorkflowMock = executeWorkflow as ReturnType<typeof vi.fn>;

function createTestFunction() {
  return createWorkflowRunRequestedFunction({
    id: "workflow-test-function",
    name: "Workflow Test Function",
    workflowId: "workflow_123",
  });
}

async function executeWorkflowFunctionForTest() {
  const workflowRunRequestedFunction = createTestFunction();
  const engine = new InngestTestEngine({
    function: workflowRunRequestedFunction,
  });

  executeWorkflowMock.mockResolvedValueOnce({
    success: true,
    outputs: {},
    results: {},
  });

  const execution = await engine.execute({
    events: [
      {
        name: "workflow/run.requested",
        data: { nodes: [], edges: [] },
      },
    ],
  });

  const runtime = executeWorkflowMock.mock.calls.at(-1)?.[1] as
    | WorkflowExecutionRuntime
    | undefined;
  if (!runtime) {
    throw new Error("Expected executeWorkflow to receive a runtime.");
  }

  return { runtime, ctx: execution.ctx };
}

describe("workflowRunRequestedFunction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a workflow-specific trigger expression", () => {
    expect(createWorkflowTriggerExpression("workflow_123")).toBe(
      'event.data.workflowId == "workflow_123"'
    );
  });

  it("creates workflow-specific function metadata", () => {
    const workflowRunRequestedFunction = createTestFunction();
    expect(workflowRunRequestedFunction.id()).toBe("workflow-test-function");
    expect(workflowRunRequestedFunction.name).toBe("Workflow Test Function");
  });

  it("forwards event data and runtime to executeWorkflow", async () => {
    const workflowRunRequestedFunction = createTestFunction();
    const workflowInput = {
      nodes: [],
      edges: [],
      executionId: "exec_123",
      workflowId: "workflow_123",
    };
    const expectedResult = { success: true, outputs: {}, results: {} };
    executeWorkflowMock.mockResolvedValueOnce(expectedResult);

    const engine = new InngestTestEngine({
      function: workflowRunRequestedFunction,
    });

    const { result } = await engine.execute({
      events: [{ name: "workflow/run.requested", data: workflowInput }],
    });

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    const [input, runtime] = executeWorkflowMock.mock.calls[0] as [
      typeof workflowInput,
      WorkflowExecutionRuntime,
    ];
    expect(input).toEqual(workflowInput);
    expect(runtime).toMatchObject({
      sleep: expect.any(Function),
      waitForEvent: expect.any(Function),
    });
    expect(result).toEqual(expectedResult);
  });

  it("runtime.sleep skips non-positive durations", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const sleepSpy = vi.spyOn(ctx.step, "sleep").mockResolvedValue(undefined);

    await runtime.sleep("sleep-zero", 0);
    await runtime.sleep("sleep-negative", -100);
    await runtime.sleep("sleep-positive", 1500);

    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith("sleep-positive", 1500);
  });

  it("runtime.waitForEvent converts timeoutMs to Inngest duration format", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const waitForEventSpy = vi.spyOn(ctx.step, "waitForEvent");
    const waitResult = {
      id: "evt_123",
      name: "workflow/wait.signal",
      data: { resumed: true },
      ts: Date.now(),
    };

    waitForEventSpy
      .mockResolvedValueOnce(waitResult)
      .mockResolvedValueOnce(null);

    const result = await runtime.waitForEvent("wait-hook", {
      event: "workflow/wait.signal",
      ifExpression: "async.data.executionId == event.data.executionId",
      timeoutMs: 1500,
    });

    expect(result).toBe(waitResult);
    expect(waitForEventSpy).toHaveBeenNthCalledWith(1, "wait-hook", {
      event: "workflow/wait.signal",
      if: "async.data.executionId == event.data.executionId",
      timeout: "2s",
    });

    await runtime.waitForEvent("wait-hook-default-timeout", {
      event: "workflow/wait.signal",
    });

    expect(waitForEventSpy).toHaveBeenNthCalledWith(
      2,
      "wait-hook-default-timeout",
      {
        event: "workflow/wait.signal",
        if: undefined,
        timeout: "365d",
      }
    );
  });
});
