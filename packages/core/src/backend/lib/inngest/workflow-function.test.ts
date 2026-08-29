import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { InngestTestEngine, InngestTestRun } from "@inngest/test";
import { Inngest } from "inngest";
import { metadataMiddleware } from "inngest/experimental";
import { Effect } from "effect";
import { noWorkflowActions } from "#src/backend/engine/actions";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import {
  noopWorkflowStore,
  type WorkflowStore,
} from "#src/backend/engine/store";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import {
  createWorkflowBranchFunction,
  createWorkflowRunFunction,
} from "#src/backend/lib/inngest/workflow-function";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import type { Workflow, WorkflowVersion } from "#src/backend/lib/db/schema";
import type { ExecutionSummary } from "#src/backend/services/executions/repo";

const executeWorkflowMock = vi.fn();

// The app builds both of these from what it owns; the engine underneath is
// injected, so identity is all this file needs from either.
const testActions = noWorkflowActions;
const testStore = noopWorkflowStore;
const testGraph = createSerializedWorkflowGraph({ nodes: [], edges: [] });
const testWorkflow: Workflow = {
  id: "workflow_123",
  name: "Donor intake follow-up",
  description: null,
  graph: testGraph,
  isPaused: false,
  mode: "live",
  visibility: "private",
  publishedVersionId: "ver_1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const testVersion: WorkflowVersion = {
  id: "ver_1",
  workflowId: testWorkflow.id,
  version: 1,
  kind: "published",
  graph: testGraph,
  catalogFingerprint: "fp",
  graphDigest: "digest",
  publishedAt: new Date("2026-01-01T00:00:00.000Z"),
};
const testExecution: ExecutionSummary = {
  id: "exec_123",
  workflowId: testWorkflow.id,
  workflowVersionId: testVersion.id,
  versionKind: "published",
  status: "running",
  startSource: "event",
  runMode: "live",
  startEventName: "donor/intake.submitted",
  entityValue: null,
  input: {},
  output: null,
  error: null,
  startedAt: new Date("2026-01-01T00:00:00.000Z"),
  completedAt: null,
  duration: null,
};
const findSummaryById = vi.fn(() => Effect.succeed(testExecution));
const testAppRuntime = stubWfGraphRuntime({
  executionRepo: {
    findSummaryById,
  },
  workflowRepo: {
    findById: () => Effect.succeed(testWorkflow),
    findVersionById: () => Effect.succeed(testVersion),
  },
});

afterAll(() => testAppRuntime.dispose());

/** Records how often the app was asked for a surface, which is per invocation. */
const buildTestActions = vi.fn(() => testActions);

/**
 * The client the app builds, middleware and all. `metadataMiddleware` is what
 * makes `client.metadata` reachable, and the run's own metadata step calls it.
 */
function createTestClient() {
  return new Inngest({
    id: "workflow-function-test",
    isDev: true,
    middleware: [metadataMiddleware()],
  });
}

function createTestFunction() {
  return createWorkflowRunFunction(createTestClient(), {
    actions: buildTestActions,
    store: testStore,
    appRuntime: testAppRuntime,
    // This file tests the Inngest handler's wiring, so the engine underneath
    // it is a stand-in handed through the ports rather than a module spy.
    executeWorkflow: executeWorkflowMock,
    executeWorkflowBranch: vi.fn(),
  });
}

/**
 * The payload a run arrives on after the persisted reload. A case spells out
 * only what it varies, so what the case is about is what stands out at its
 * call site.
 */
function persistedRunInput(varied: Record<string, unknown> = {}) {
  return {
    graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
    workflowVersionId: "ver_1",
    catalogFingerprint: "fp",
    startPayload: {},
    requestPayload: {},
    startEventName: testExecution.startEventName,
    executionId: "exec_123",
    workflowId: "workflow_123",
    workflowName: testWorkflow.name,
    runMode: testExecution.runMode,
    ...varied,
  };
}

function runRequestData() {
  return { executionId: testExecution.id };
}

function branchInvokeData(
  varied: { entryNodeId?: string; releasedNodeIds?: string[] } = {}
) {
  return {
    executionId: testExecution.id,
    entryNodeId: varied.entryNodeId ?? "wait_1",
    releasedNodeIds: varied.releasedNodeIds ?? [],
  };
}

/**
 * Replaces the SDK's metadata builder with one that records, so a case can read
 * the values and the kind a run attaches to itself. Spied on the prototype
 * because `metadata` is a getter there rather than an own property.
 */
function recordRunMetadata(update: () => Promise<void>) {
  const run = vi.fn(() => ({ update }));
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the handler reaches for `.run().update()` and nothing else on the builder
  vi.spyOn(Inngest.prototype, "metadata", "get").mockReturnValue({
    run,
  } as never);
  return run;
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
    events: [{ name: "workflow/run.requested", data: runRequestData() }],
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
    executeWorkflowMock.mockReset();
    buildTestActions.mockClear();
    findSummaryById.mockReset();
    findSummaryById.mockImplementation(() => Effect.succeed(testExecution));
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
  it("registers the branch as invoke-only, not a public event", () => {
    const branchFunction = createWorkflowBranchFunction(createTestClient(), {
      actions: buildTestActions,
      store: testStore,
      appRuntime: testAppRuntime,
      executeWorkflow: vi.fn(),
      executeWorkflowBranch: vi.fn(),
    });

    expect(branchFunction.id()).toBe("workflow-branch");
    expect(branchFunction.name).toBe("Workflow branch");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const { opts } = branchFunction as {
      opts: { triggers: { event?: string; name?: string }[] };
    };
    expect(opts.triggers).toHaveLength(1);
    expect(opts.triggers[0]?.event).toBe("inngest/function.invoked");
    expect(opts.triggers[0]?.name).toBe("inngest/function.invoked");
  });

  /**
   * Both registrations above carry one name for every run, so what tells two
   * runs apart in the Inngest UI is what the run writes about itself here.
   */
  it("attaches the run's identity to Inngest as metadata", async () => {
    const update = vi.fn(() => Promise.resolve());
    const run = recordRunMetadata(update);
    executeWorkflowMock.mockReturnValue(
      Effect.succeed({ success: true, outputs: {}, results: {} })
    );

    await new InngestTestEngine({ function: createTestFunction() }).execute({
      events: [
        {
          name: "workflow/run.requested",
          data: runRequestData(),
        },
      ],
    });

    // Scoped to the run rather than to the step that wrote it, which is what
    // puts it on the run's own Metadata tab.
    expect(run).toHaveBeenCalledWith();
    expect(update).toHaveBeenCalledWith(
      {
        workflow: "Donor intake follow-up",
        workflowId: "workflow_123",
        executionId: "exec_123",
        runMode: "live",
        triggerEvent: "donor/intake.submitted",
        versionId: "ver_1",
        nodes: 0,
      },
      "wfgraph"
    );
  });

  /** A run that did its work has not failed because a label would not attach. */
  it("runs on when Inngest refuses the metadata write", async () => {
    recordRunMetadata(() => Promise.reject(new Error("metadata too large")));
    const expectedResult = { success: true, outputs: {}, results: {} };
    executeWorkflowMock.mockReturnValue(Effect.succeed(expectedResult));

    const { result } = await new InngestTestEngine({
      function: createTestFunction(),
    }).execute({
      events: [{ name: "workflow/run.requested", data: runRequestData() }],
    });

    expect(result).toEqual(expectedResult);
  });

  /**
   * A branch is a durable run of its own, so it needs its own label, and the
   * node it entered at is what tells two branches of one run apart.
   */
  it("names the entry node in a branch run's metadata", async () => {
    const update = vi.fn(() => Promise.resolve());
    recordRunMetadata(update);
    const executeWorkflowBranch = vi.fn((..._args: [unknown, ...unknown[]]) =>
      Effect.succeed({ results: {}, outputs: {} })
    );

    await new InngestTestEngine({
      function: createWorkflowBranchFunction(createTestClient(), {
        actions: buildTestActions,
        store: testStore,
        appRuntime: testAppRuntime,
        executeWorkflow: vi.fn(),
        executeWorkflowBranch,
      }),
    }).execute({
      events: [
        {
          name: "inngest/function.invoked",
          data: branchInvokeData(),
        },
      ],
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: "Donor intake follow-up",
        entryNode: "wait_1",
      }),
      "wfgraph"
    );
  });

  /**
   * The invoke payload names the Wait, not the graph. The published version
   * the execution pins is what the branch walks, so a chosen graph on the
   * wire cannot select HTTP or credentialed steps.
   */
  it("walks the persisted published graph, not a graph on the invoke", async () => {
    const executeWorkflowBranch = vi.fn((..._args: [unknown, ...unknown[]]) =>
      Effect.succeed({ results: {}, outputs: {} })
    );

    await new InngestTestEngine({
      function: createWorkflowBranchFunction(createTestClient(), {
        actions: buildTestActions,
        store: testStore,
        appRuntime: testAppRuntime,
        executeWorkflow: vi.fn(),
        executeWorkflowBranch,
      }),
    }).execute({
      events: [
        {
          name: "inngest/function.invoked",
          data: branchInvokeData({
            entryNodeId: "wait_1",
            releasedNodeIds: ["entry_1"],
          }),
        },
      ],
    });

    expect(executeWorkflowBranch).toHaveBeenCalledTimes(1);
    expect(executeWorkflowBranch.mock.calls[0]?.[0]).toEqual({
      ...persistedRunInput(),
      entryNodeId: "wait_1",
      releasedNodeIds: ["entry_1"],
    });
  });

  it.each(["completed", "canceled", "superseded", "failed"] as const)(
    "refuses to walk a %s execution as a branch",
    async (status) => {
      findSummaryById.mockImplementation(() =>
        Effect.succeed({ ...testExecution, status })
      );
      const executeWorkflowBranch = vi.fn();

      const testEngine = new InngestTestEngine({
        function: createWorkflowBranchFunction(createTestClient(), {
          actions: buildTestActions,
          store: testStore,
          appRuntime: testAppRuntime,
          executeWorkflow: vi.fn(),
          executeWorkflowBranch,
        }),
        events: [
          {
            name: "inngest/function.invoked",
            data: branchInvokeData(),
          },
        ],
      });
      const { result } = await new InngestTestRun({ testEngine }).waitFor(
        "function-rejected"
      );

      expect(executeWorkflowBranch).not.toHaveBeenCalled();
      expect(result.retriable).toBe(false);
      expect(result.error).toMatchObject({
        message: "The requested workflow execution is no longer in flight",
      });
    }
  );

  it("forwards event data, runtime, store and actions to executeWorkflow", async () => {
    const workflowRunRequestedFunction = createTestFunction();
    const expectedResult = { success: true, outputs: {}, results: {} };
    executeWorkflowMock.mockReturnValueOnce(Effect.succeed(expectedResult));

    const engine = new InngestTestEngine({
      function: workflowRunRequestedFunction,
    });

    const { result, ctx } = await engine.execute({
      events: [{ name: "workflow/run.requested", data: runRequestData() }],
    });

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
    const [input, runtime, store, actions] = executeWorkflowMock.mock
      .calls[0] as [
      ReturnType<typeof persistedRunInput>,
      WorkflowExecutionRuntime,
      WorkflowStore,
      typeof testActions,
    ];
    expect(input).toEqual(persistedRunInput());
    expect(runtime).toMatchObject({
      sleep: expect.any(Function),
      waitForEvent: expect.any(Function),
      run: expect.any(Function),
      runId: expect.any(String),
    });
    expect(runtime.runId).toBe(ctx.runId);
    // A live run must be recorded: the handler runs on the store the app built
    // for it rather than on one of its own.
    expect(store).toBe(testStore);
    // And the dispatch port the app built, which is where an action id becomes
    // work. It is asked for per invocation of the body, because the surface
    // holds an integration's credentials for its own lifetime. Two invocations
    // here: the run's `run-metadata` step parks the first one, and the engine
    // is reached on the one that replays past it.
    expect(actions).toBe(testActions);
    expect(buildTestActions).toHaveBeenCalledTimes(2);
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
      events: [{ name: "workflow/run.requested", data: runRequestData() }],
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

  /**
   * A forged or re-delivered `workflow/run.requested` for a row that already
   * ended must not walk the graph again. `finishRun` will not reclaim the
   * terminal row, but the steps would still fire.
   */
  it.each(["completed", "canceled", "superseded", "failed"] as const)(
    "refuses to walk a %s execution",
    async (status) => {
      findSummaryById.mockImplementation(() =>
        Effect.succeed({ ...testExecution, status })
      );

      const testEngine = new InngestTestEngine({
        function: createTestFunction(),
        events: [{ name: "workflow/run.requested", data: runRequestData() }],
      });
      const { result } = await new InngestTestRun({ testEngine }).waitFor(
        "function-rejected"
      );

      expect(executeWorkflowMock).not.toHaveBeenCalled();
      expect(result.retriable).toBe(false);
      expect(result.error).toMatchObject({
        message: "The requested workflow execution is no longer in flight",
      });
    }
  );

  it("still walks a waiting execution, which is how a resume replays", async () => {
    findSummaryById.mockImplementation(() =>
      Effect.succeed({ ...testExecution, status: "waiting" })
    );
    executeWorkflowMock.mockReturnValueOnce(
      Effect.succeed({ success: true, outputs: {}, results: {} })
    );

    await new InngestTestEngine({ function: createTestFunction() }).execute({
      events: [{ name: "workflow/run.requested", data: runRequestData() }],
    });

    expect(executeWorkflowMock).toHaveBeenCalledTimes(1);
  });

  it("runtime.step maps onto step.run so node work is memoized across replays", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const runSpy = vi
      .spyOn(ctx.step, "run")
      .mockResolvedValue("memoized-result");

    const work = () => Promise.resolve("fresh-result");
    const step = { id: "node:action_1", name: "Send email: post" };
    const result = await runtime.run(step, work);

    // Counted by id rather than in total: the body suspends at its own
    // `run-metadata` step, and the invocation that parked there is still
    // unwinding when this spy goes on.
    expect(
      runSpy.mock.calls.filter(
        // The engine always names a step with an object; Inngest's own signature
        // also allows a bare id, which nothing here passes.
        ([called]) => typeof called !== "string" && called.id === step.id
      )
    ).toHaveLength(1);
    // The id and the display name both reach Inngest: the first memoizes, the
    // second is what the trace prints in place of the node's opaque id.
    expect(runSpy).toHaveBeenCalledWith(step, work);
    // The stored value wins over re-running the work: that is the whole point.
    expect(result).toBe("memoized-result");
  });

  it("hands a branch off with the run's own payload and the entry node named", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const branchResult = { results: {}, outputs: {} };
    const invokeSpy = vi
      .spyOn(ctx.step, "invoke")
      .mockResolvedValue(branchResult);

    const handoff = await runtime.startBranch?.(
      { id: "branch-wait_1", name: "Wait for reply (branch)" },
      {
        entryNodeId: "wait_1",
        releasedNodeIds: ["entry_1"],
      }
    );

    // The branch names the execution and the Wait it starts at. The graph stays
    // behind: the child reloads it from the pinned published version.
    expect(invokeSpy).toHaveBeenCalledWith(
      { id: "branch-wait_1", name: "Wait for reply (branch)" },
      {
        function: expect.anything(),
        data: {
          executionId: "exec_123",
          entryNodeId: "wait_1",
          releasedNodeIds: ["entry_1"],
        },
      }
    );
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
      runtime.startBranch?.(
        { id: "branch-wait_1" },
        {
          entryNodeId: "wait_1",
          releasedNodeIds: [],
        }
      )
    ).resolves.toEqual({ status: "killed" });

    invokeSpy.mockResolvedValueOnce({ _inngest: { status: "Cancelled" } });
    await expect(
      runtime.startBranch?.(
        { id: "branch-wait_2" },
        {
          entryNodeId: "wait_2",
          releasedNodeIds: [],
        }
      )
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
      runtime.startBranch?.(
        { id: "branch-wait_1" },
        {
          entryNodeId: "wait_1",
          releasedNodeIds: [],
        }
      )
    ).rejects.toThrow(/results: Missing key/);
  });

  it("refuses a results map whose entries are not outcomes", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    vi.spyOn(ctx.step, "invoke").mockResolvedValue({
      results: { reminder: { sent: true } },
      outputs: {},
    });

    await expect(
      runtime.startBranch?.(
        { id: "branch-wait_1" },
        {
          entryNodeId: "wait_1",
          releasedNodeIds: [],
        }
      )
    ).rejects.toThrow(/shape this run cannot read/);
  });

  it("runtime.sleep skips non-positive durations", async () => {
    const { runtime, ctx } = await executeWorkflowFunctionForTest();
    const sleepSpy = vi.spyOn(ctx.step, "sleep").mockResolvedValue(undefined);

    await runtime.sleep({ id: "sleep-zero" }, 0);
    await runtime.sleep({ id: "sleep-negative" }, -100);
    await runtime.sleep({ id: "sleep-positive" }, 1500);

    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith({ id: "sleep-positive" }, 1500);
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

    const result = await runtime.waitForEvent(
      { id: "wait-hook" },
      {
        event: "workflow/wait.signal",
        ifExpression: "async.data.executionId == event.data.executionId",
        timeoutMs: 1500,
      }
    );

    expect(result).toBe(waitResult);
    expect(waitForEventSpy).toHaveBeenNthCalledWith(
      1,
      { id: "wait-hook" },
      {
        event: "workflow/wait.signal",
        if: "async.data.executionId == event.data.executionId",
        timeout: "2s",
      }
    );

    await runtime.waitForEvent(
      { id: "wait-hook-default-timeout" },
      {
        event: "workflow/wait.signal",
      }
    );

    expect(waitForEventSpy).toHaveBeenNthCalledWith(
      2,
      { id: "wait-hook-default-timeout" },
      {
        event: "workflow/wait.signal",
        if: undefined,
        timeout: "365d",
      }
    );
  });
});
