import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InngestTestEngine, InngestTestRun } from "@inngest/test";
import { Inngest } from "inngest";
import { Effect } from "effect";
import { noWorkflowActions } from "#src/backend/engine/actions";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import {
  noopWorkflowStore,
  type WorkflowStore,
} from "#src/backend/engine/store";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import {
  createWorkflowBranchFunction,
  createWorkflowRunFunction,
} from "#src/backend/lib/inngest/workflow-function";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";

const { executeWorkflowMock } = vi.hoisted(() => ({
  executeWorkflowMock: vi.fn(),
}));

// This file tests the Inngest handler's wiring, so the engine underneath it is
// replaced outright. The mock is scoped to this file: vitest gives each test
// file its own module registry, so core-replay.test.ts still runs the real
// engine and observes a real suspend. `executeWorkflow` is the module's only
// runtime export, the rest being types, so nothing else needs supplying.
vi.mock("#src/backend/engine/core", () => ({
  executeWorkflow: executeWorkflowMock,
}));

// The app builds both of these from what it owns; the engine underneath is
// mocked, so identity is all this file needs from either.
const testActions = noWorkflowActions;
const testStore = noopWorkflowStore;
const testAppRuntime = stubRovaRuntime();

afterAll(() => testAppRuntime.dispose());

/** Records how often the app was asked for a surface, which is per invocation. */
const buildTestActions = vi.fn(() => testActions);

function createTestFunction() {
  return createWorkflowRunFunction(
    new Inngest({ id: "workflow-function-test", isDev: true }),
    {
      actions: buildTestActions,
      store: testStore,
      appRuntime: testAppRuntime,
    }
  );
}

async function executeWorkflowFunctionForTest() {
  const workflowRunRequestedFunction = createTestFunction();
  const engine = new InngestTestEngine({
    function: workflowRunRequestedFunction,
  });

  executeWorkflowMock.mockReturnValueOnce(
    Effect.succeed({
      success: true,
      outputs: {},
      results: {},
    })
  );

  const execution = await engine.execute({
    events: [
      {
        name: "workflow/run.requested",
        data: {
          graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
          workflowVersionId: "ver_1",
          catalogFingerprint: "fp",
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

describe("the workflow run function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // One function serves every workflow, so its id is a constant rather than
  // something a build derives; `functions.test.ts` pins the unfiltered trigger
  // that lets it.
  it("registers under one id whatever workflows exist", () => {
    const runFunction = createTestFunction();
    expect(runFunction.id()).toBe("workflow-run");
    expect(runFunction.name).toBe("Workflow run");
  });

  /**
   * A second registration rather than a mode of the first, because `cancelOn`
   * is declared per function: a branch is killed where it stands and the run
   * that started it must not be.
   */
  it("registers the branch as a function of its own", () => {
    const branchFunction = createWorkflowBranchFunction(
      new Inngest({ id: "workflow-function-test", isDev: true }),
      {
        actions: buildTestActions,
        store: testStore,
        appRuntime: testAppRuntime,
      }
    );

    expect(branchFunction.id()).toBe("workflow-branch");
    expect(branchFunction.name).toBe("Workflow branch");
  });

  it("forwards event data, runtime, store and actions to executeWorkflow", async () => {
    const workflowRunRequestedFunction = createTestFunction();
    const workflowInput = {
      graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      workflowVersionId: "ver_1",
      catalogFingerprint: "fp",
      executionId: "exec_123",
      workflowId: "workflow_123",
    };
    const expectedResult = { success: true, outputs: {}, results: {} };
    executeWorkflowMock.mockReturnValueOnce(Effect.succeed(expectedResult));

    const engine = new InngestTestEngine({
      function: workflowRunRequestedFunction,
    });

    const { result } = await engine.execute({
      events: [{ name: "workflow/run.requested", data: workflowInput }],
    });

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    const [input, runtime, store, actions] = executeWorkflowMock.mock
      .calls[0] as [
      typeof workflowInput,
      WorkflowExecutionRuntime,
      WorkflowStore,
      typeof testActions,
    ];
    expect(input).toEqual(workflowInput);
    expect(runtime).toMatchObject({
      sleep: expect.any(Function),
      waitForEvent: expect.any(Function),
      run: expect.any(Function),
    });
    // A live run must be recorded: the handler runs on the store the app built
    // for it rather than on one of its own.
    expect(store).toBe(testStore);
    // And the dispatch port the app built, which is where an action id becomes
    // work. It is asked for per invocation of the body, because the surface
    // holds an integration's credentials for its own lifetime.
    expect(actions).toBe(testActions);
    expect(buildTestActions).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expectedResult);
  });

  /**
   * The run already recorded its terminal status, inside a memoized step, so a
   * further attempt of this body replays that write from the memo and reaches a
   * database that refuses to move a terminal row. A Wait node on the way would
   * find `createWaitState` declining to park the run at all.
   */
  it("ends a run that failed without asking for another attempt", async () => {
    executeWorkflowMock.mockReturnValueOnce(
      Effect.succeed({
        success: false,
        outputs: {},
        results: {
          email_1: {
            success: false,
            error: { message: "the vendor said no" },
          },
        },
      })
    );

    const testEngine = new InngestTestEngine({
      function: createTestFunction(),
      events: [
        {
          name: "workflow/run.requested",
          data: {
            graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
            workflowVersionId: "ver_1",
            catalogFingerprint: "fp",
            executionId: "exec_123",
            workflowId: "workflow_123",
          },
        },
      ],
    });
    // The rejected checkpoint rather than `execute`, which hands back the error
    // alone: whether Inngest will try again is the assertion here.
    const { result } = await new InngestTestRun({ testEngine }).waitFor(
      "function-rejected"
    );

    expect(result.retriable).toBe(false);
    // The nodes that failed are named, which is the whole of what the attempt
    // shows in Inngest.
    expect(result.error).toMatchObject({
      message: "email_1: the vendor said no",
    });
  });

  it("runtime.step maps onto step.run so node work is memoized across replays", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const runSpy = vi
      .spyOn(ctx.step, "run")
      .mockResolvedValue("memoized-result");

    const work = () => Promise.resolve("fresh-result");
    const result = await runtime.run("node:action_1", work);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith("node:action_1", work);
    // The stored value wins over re-running the work: that is the whole point.
    expect(result).toBe("memoized-result");
  });

  it("hands a branch off with the run's own payload and the entry node named", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const branchResult = { results: {}, outputs: {} };
    const invokeSpy = vi
      .spyOn(ctx.step, "invoke")
      .mockResolvedValue(branchResult);

    const handoff = await runtime.startBranch?.("branch-wait_1", {
      entryNodeId: "wait_1",
      releasedNodeIds: ["entry_1"],
    });

    // The branch carries the graph, the run's identity, and the ids of the nodes
    // that let it start. What those nodes produced stays behind: it reads their
    // outputs back from the store.
    expect(invokeSpy).toHaveBeenCalledWith("branch-wait_1", {
      function: expect.anything(),
      data: {
        graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
        workflowVersionId: "ver_1",
        catalogFingerprint: "fp",
        executionId: "exec_123",
        workflowId: "workflow_123",
        entryNodeId: "wait_1",
        releasedNodeIds: ["entry_1"],
      },
    });
    expect(handoff).toEqual({ status: "finished", result: branchResult });
  });

  /**
   * The one outcome that cannot be read off a rejection. A cancelled branch
   * resolves, with Inngest's own end-of-run envelope in place of the value the
   * branch would have returned.
   */
  it("reads a cancelled branch invocation as a kill", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const invokeSpy = vi.spyOn(ctx.step, "invoke");

    invokeSpy.mockResolvedValueOnce({
      data: { _inngest: { status: "Cancelled" } },
    });
    await expect(
      runtime.startBranch?.("branch-wait_1", {
        entryNodeId: "wait_1",
        releasedNodeIds: [],
      })
    ).resolves.toEqual({ status: "killed" });

    invokeSpy.mockResolvedValueOnce({ _inngest: { status: "Cancelled" } });
    await expect(
      runtime.startBranch?.("branch-wait_2", {
        entryNodeId: "wait_2",
        releasedNodeIds: [],
      })
    ).resolves.toEqual({ status: "killed" });
  });

  /**
   * The answer becomes the run's own results, so it is decoded as strictly as
   * the payload that started the branch was.
   */
  it("refuses a branch answer it cannot read", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    vi.spyOn(ctx.step, "invoke").mockResolvedValue({ sent: true });

    await expect(
      runtime.startBranch?.("branch-wait_1", {
        entryNodeId: "wait_1",
        releasedNodeIds: [],
      })
    ).rejects.toThrow(/results: Missing key/);
  });

  it("refuses a results map whose entries are not outcomes", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    vi.spyOn(ctx.step, "invoke").mockResolvedValue({
      results: { reminder: { sent: true } },
      outputs: {},
    });

    await expect(
      runtime.startBranch?.("branch-wait_1", {
        entryNodeId: "wait_1",
        releasedNodeIds: [],
      })
    ).rejects.toThrow(/shape this run cannot read/);
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
