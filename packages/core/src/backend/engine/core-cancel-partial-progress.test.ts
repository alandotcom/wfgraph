import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { unknownRest } from "@wfgraph/shared/types/schema";
import { defineAction } from "#src/backend/extensions/define-action";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import type { ExecutionTerminationState } from "#src/backend/engine/store";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";

const START_EVENT = "test/start";
const CANCEL_EVENT = "test/cancel";
const RECORD_ACTION_ID = "test/partial-progress-recorder";

const cancelRules: JsonObject = {
  lifecycleRules: {
    concurrency: "newest-wins",
    startEvents: [START_EVENT],
    cancelEvents: [CANCEL_EVENT],
    allowManualStart: true,
  },
};

const actions = createWorkflowActions(
  assembleExtensions({
    actions: [
      defineAction({
        id: RECORD_ACTION_ID,
        label: "Record",
        description: "Returns its marker or fails with it",
        input: Schema.StructWithRest(Schema.Struct({}), unknownRest),
        handler: ({ input }) => {
          const marker = String(input.marker ?? "");
          if (marker.startsWith("fail-")) {
            throw new Error(`${marker} failed`);
          }
          return { marker };
        },
      }),
    ],
  }),
  stubWfGraphRuntime()
);

function lifecycleNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { type: "lifecycle", label: "Lifecycle", config: cancelRules },
  };
}

function actionNode(id: string, config: Record<string, unknown>): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: id,
      config: { actionType: RECORD_ACTION_ID, ...config },
    },
  };
}

function waitNode(id: string, duration: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      type: "action",
      label: id,
      config: {
        actionType: BUILT_IN_ACTION_IDS.wait,
        waitMode: "delay",
        waitDuration: duration,
        waitGateMode: "require_actual_wait",
      },
    },
  };
}

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
    const graph = createSerializedWorkflowGraph({
      nodes: [
        lifecycleNode("entry"),
        waitNode("wait-a", "2s"),
        actionNode("output-a", { marker: "output-a" }),
        actionNode("fail-a", { marker: "fail-a" }),
        waitNode("nested-wait", "12s"),
        waitNode("wait-b", "3s"),
        actionNode("output-b", { marker: "output-b" }),
        actionNode("fail-b", { marker: "fail-b" }),
        actionNode("cancel-output", {
          marker: "{{@output-a:output-a.data.marker}}",
        }),
      ],
      edges: [
        {
          id: "entry-a",
          source: "entry",
          sourceHandle: "started",
          target: "wait-a",
        },
        { id: "a-output", source: "wait-a", target: "output-a" },
        { id: "a-failure", source: "output-a", target: "fail-a" },
        { id: "a-nested", source: "fail-a", target: "nested-wait" },
        {
          id: "entry-b",
          source: "entry",
          sourceHandle: "started",
          target: "wait-b",
        },
        { id: "b-output", source: "wait-b", target: "output-b" },
        { id: "b-failure", source: "output-b", target: "fail-b" },
        {
          id: "entry-canceled",
          source: "entry",
          sourceHandle: "canceled",
          target: "cancel-output",
        },
      ],
    });
    const executionInput = {
      graph,
      executionId: "exec_partial_cancel",
      workflowId: "workflow_partial_cancel",
      startPayload: {},
      startEventName: START_EVENT,
    };

    const run = await driveWithReplay(
      (runtime) =>
        executeTestWorkflow(
          executionInput,
          cancelAtFinalRead(runtime, store),
          store,
          actions
        ),
      {
        killBranchesAtMs: 5_000,
        branch: (runtime, branchInput) =>
          executeTestWorkflow(
            { ...executionInput, ...branchInput },
            runtime,
            store,
            actions
          ),
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
