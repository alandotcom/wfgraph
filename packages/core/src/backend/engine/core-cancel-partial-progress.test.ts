import { describe, expect, it } from "vitest";
import {
  executeTestWorkflow,
  executeTestWorkflowBranch,
} from "#src/backend/engine/test-execution";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import type { ExecutionTerminationState } from "#src/backend/engine/store";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";
import {
  actions,
  CANCEL_EVENT,
  defineCancelPartialProgressReplayCases,
  executionInput,
} from "#src/backend/engine/core-cancel-partial-progress.replay-cases";

/** Injects a late Cancel claim at the root's final durable status read. */
function cancelAtFinalRead(
  runtime: WorkflowExecutionRuntime,
  store: ReturnType<typeof createRecordingWorkflowStore>
): WorkflowExecutionRuntime {
  return {
    ...runtime,
    run: (step, work) =>
      runtime.run(step, () => {
        if (step.id === "execution-termination-final") {
          store.terminationState = {
            status: "running",
            claim: {
              kind: "cancel",
              requestedAt: new Date().toISOString(),
              eventName: CANCEL_EVENT,
              payload: {},
            },
            didWrite: true,
          } satisfies ExecutionTerminationState;
        }
        return work();
      }),
  };
}

describe("a canceled run with a killed child branch", () => {
  it("restores completed child outputs and failures before the Canceled outlet", async () => {
    const store = createRecordingWorkflowStore();

    const run = await driveWithReplay(
      (runtime) =>
        executeTestWorkflow(
          executionInput,
          cancelAtFinalRead(runtime, store),
          store,
          actions
        ),
      {
        executor: {
          kind: "inngest",
          killBranchesAtMs: 5_000,
          branch: (runtime, branchInput) =>
            executeTestWorkflowBranch(
              { ...executionInput, ...branchInput },
              runtime,
              store,
              actions
            ),
        },
      }
    );

    expect(run.value.status).toBe("canceled");
    expect(run.value.results["fail-a"]?.success).toBe(false);
    expect(run.value.results["fail-b"]?.success).toBe(false);
    expect(run.value.outputs["output-a"]?.data).toEqual({
      success: true,
      data: { marker: "output-a" },
    });
    expect(run.value.outputs["output-b"]?.data).toEqual({
      success: true,
      data: { marker: "output-b" },
    });
    expect(run.value.outputs["fail-a"]?.data).toBeNull();
    expect(run.value.outputs["fail-b"]?.data).toBeNull();
    expect(run.value.outputs["cancel-output"]?.data).toEqual({
      success: true,
      data: { marker: "output-a" },
    });

    const callIndex = (method: string) =>
      store.calls.findIndex((call) => call.method === method);
    expect(
      store.callsOf("createWaitState").map((call) => call.nodeId)
    ).toContain("nested-wait");
    expect(callIndex("cancelOpenWork")).toBeGreaterThanOrEqual(0);
    expect(callIndex("readCompletedNodeProgress")).toBeGreaterThan(
      callIndex("cancelOpenWork")
    );
    const canceledActionStart = store.calls.findIndex(
      (call) =>
        call.method === "startStepLog" && call.input.nodeId === "cancel-output"
    );
    expect(canceledActionStart).toBeGreaterThan(
      callIndex("readCompletedNodeProgress")
    );
  });
});

describe("under the database executor", () => {
  defineCancelPartialProgressReplayCases({ kind: "database" });
});
