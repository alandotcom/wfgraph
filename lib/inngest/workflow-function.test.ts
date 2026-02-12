import { InngestTestEngine } from "@inngest/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionRuntime } from "../workflow-executor.workflow";
import { executeWorkflow } from "../workflow-executor.workflow";
import { functions } from "./functions";
import { workflowRunRequestedFunction } from "./workflow-function";

vi.mock("../workflow-executor.workflow", () => ({
  executeWorkflow: vi.fn(),
}));

const executeWorkflowMock = vi.mocked(executeWorkflow);

async function executeWorkflowFunctionForTest() {
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

  it("is registered in the function list", () => {
    expect(functions).toContain(workflowRunRequestedFunction);
  });

  it("forwards event data and runtime to executeWorkflow", async () => {
    const workflowInput = {
      nodes: [],
      edges: [],
      executionId: "exec_123",
      workflowId: "workflow_123",
      userId: "user_123",
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
    ctx.step.sleep.mockResolvedValue(undefined);

    await runtime.sleep("sleep-zero", 0);
    await runtime.sleep("sleep-negative", -100);
    await runtime.sleep("sleep-positive", 1500);

    expect(ctx.step.sleep).toHaveBeenCalledTimes(1);
    expect(ctx.step.sleep).toHaveBeenCalledWith("sleep-positive", 1500);
  });

  it("runtime.waitForEvent converts timeoutMs to Inngest duration format", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const waitResult = {
      id: "evt_123",
      name: "workflow/wait.signal",
      data: { resumed: true },
      ts: Date.now(),
    };

    ctx.step.waitForEvent
      .mockResolvedValueOnce(waitResult)
      .mockResolvedValueOnce(null);

    const result = await runtime.waitForEvent("wait-hook", {
      event: "workflow/wait.signal",
      ifExpression: "async.data.executionId == event.data.executionId",
      timeoutMs: 1500,
    });

    expect(result).toBe(waitResult);
    expect(ctx.step.waitForEvent).toHaveBeenNthCalledWith(1, "wait-hook", {
      event: "workflow/wait.signal",
      if: "async.data.executionId == event.data.executionId",
      timeout: "2s",
    });

    await runtime.waitForEvent("wait-hook-default-timeout", {
      event: "workflow/wait.signal",
    });

    expect(ctx.step.waitForEvent).toHaveBeenNthCalledWith(
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
