/**
 * The partial-progress graph the cancel suite drives, and its case: a Cancel
 * claim that halts a parked Wait keeps the outputs
 * and failures earlier passes recorded.
 */

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
import {
  driveWithReplay,
  type ReplayExecutor,
} from "#src/backend/engine/testing/replay-runtime";
import { CANCEL_WAKE } from "#src/backend/engine/testing/wait-fixtures";
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
          const marker = typeof input.marker === "string" ? input.marker : "";
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

/**
 * Two Started branches, each a Wait then a node that succeeds and one that
 * fails, with a twelve-second Wait further down the first. The Canceled outlet
 * addresses an output the first branch left behind.
 */
const executionInput = {
  graph: createSerializedWorkflowGraph({
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
      { id: "a-nested", source: "output-a", target: "nested-wait" },
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
  }),
  executionId: "exec_partial_cancel",
  workflowId: "workflow_partial_cancel",
  startPayload: {},
  startEventName: START_EVENT,
};

export function defineCancelPartialProgressReplayCases(
  executor: ReplayExecutor
): void {
  describe("a canceled run whose Waits are parked in the one run", () => {
    // Nothing is killed in one run. The Cancel Event at five seconds writes its
    // claim and resolves the one park still open, the nested Wait, with a cancel
    // wake. Both branches already ran their nodes in their own passes, so their
    // outputs and failures are in the traversal the next pass rebuilds from the
    // memo, and nothing has to be read back from the store.
    it("keeps the outputs and failures of earlier passes when a Cancel claim halts a parked Wait", async () => {
      const store = createRecordingWorkflowStore();

      const run = await driveWithReplay(
        (runtime) =>
          executeTestWorkflow(executionInput, runtime, store, actions),
        {
          executor: {
            ...executor,
            signalOpenParksAt: {
              atMs: 5_000,
              wake: CANCEL_WAKE,
              write: () => {
                store.terminationState = {
                  status: "running",
                  claim: {
                    kind: "cancel",
                    requestedAt: new Date().toISOString(),
                    eventName: CANCEL_EVENT,
                    payload: {},
                  },
                  didWrite: true,
                };
              },
            },
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
      expect(run.elapsedMs).toBe(5_000);

      // The nested Wait parked and its row closed on the cancel wake before the
      // Canceled outlet opened a row.
      expect(
        store.callsOf("createWaitState").map((call) => call.nodeId)
      ).toContain("nested-wait");
      const closedAt = store.calls.findIndex(
        (call) =>
          call.method === "markWaitStateStatus" &&
          call.input.status === "cancelled"
      );
      const canceledActionStart = store.calls.findIndex(
        (call) =>
          call.method === "startStepLog" &&
          call.input.nodeId === "cancel-output"
      );
      expect(closedAt).toBeGreaterThanOrEqual(0);
      expect(canceledActionStart).toBeGreaterThan(closedAt);
    });
  });
}
