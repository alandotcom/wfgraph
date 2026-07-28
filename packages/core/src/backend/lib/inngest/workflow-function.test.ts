import { beforeEach, describe, expect, it, vi } from "vitest";
import { InngestTestEngine } from "@inngest/test";
import { dbWorkflowStore } from "@/backend/lib/workflow-engine/db-store";
import type { WorkflowExecutionRuntime } from "@/backend/lib/workflow-engine/runtime";
import type { WorkflowStore } from "@/backend/lib/workflow-engine/store";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import {
  createWorkflowRunRequestedFunction,
  createWorkflowTriggerExpression,
} from "./workflow-function";

// vi.hoisted, because vitest lifts vi.mock above every import, and the factory
// below reads this the moment the handler module is imported.
const { executeWorkflowMock } = vi.hoisted(() => ({
  executeWorkflowMock: vi.fn(),
}));

// This file tests the Inngest handler's wiring, so the engine underneath it is
// replaced outright. The mock is scoped to this file: vitest gives each test
// file its own module registry, so core-replay.test.ts still runs the real
// engine and observes a real suspend. `executeWorkflow` is the module's only
// runtime export, the rest being types, so nothing else needs supplying.
vi.mock("@/backend/lib/workflow-engine/core", () => ({
  executeWorkflow: executeWorkflowMock,
}));

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
        data: {
          graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
          executionId: "exec_123",
          workflowId: "workflow_123",
        },
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

  it("forwards event data, runtime, and the database store to executeWorkflow", async () => {
    const workflowRunRequestedFunction = createTestFunction();
    const workflowInput = {
      graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
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
    const [input, runtime, store] = executeWorkflowMock.mock.calls[0] as [
      typeof workflowInput,
      WorkflowExecutionRuntime,
      WorkflowStore,
    ];
    expect(input).toEqual(workflowInput);
    expect(runtime).toMatchObject({
      sleep: expect.any(Function),
      waitForEvent: expect.any(Function),
      step: expect.any(Function),
    });
    // A live run must be recorded: this handler is the only place that wires
    // the engine's persistence port to the database.
    expect(store).toBe(dbWorkflowStore);
    expect(result).toEqual(expectedResult);
  });

  it("runtime.step maps onto step.run so node work is memoized across replays", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const runSpy = vi
      .spyOn(ctx.step, "run")
      .mockResolvedValue("memoized-result");

    const work = () => Promise.resolve("fresh-result");
    const result = await runtime.step("node:action_1", work);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith("node:action_1", work);
    // The stored value wins over re-running the work: that is the whole point.
    expect(result).toBe("memoized-result");
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
