/**
 * A host action's handler across the passes of a run: it runs inside one
 * durable step of its node, so a run that parks below it and resumes does not
 * call it again, whether or not it put its work in `step.run`.
 */

import { Schema } from "effect";
import { beforeEach, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { defineAction } from "#src/backend/extensions/define-action";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import {
  driveWithReplay,
  type ReplayExecutor,
} from "#src/backend/engine/testing/replay-runtime";

const REFUND_ACTION_ID = "test/memo-refund";

/** Every refund the handler issued, outside any `step.run`. */
const refunds: string[] = [];
/** Every key the handler was handed, by pass. */
const keys: string[] = [];

const actions = createWorkflowActions(
  assembleExtensions({
    actions: [
      defineAction({
        id: REFUND_ACTION_ID,
        label: "Refund",
        description: "Issues a refund outside any step",
        input: Schema.Struct({}),
        output: Schema.Struct({ refundId: Schema.String }),
        handler: ({ nodeId, idempotencyKey }) => {
          refunds.push(nodeId);
          keys.push(idempotencyKey);
          return { refundId: `re_${nodeId}` };
        },
      }),
    ],
  }),
  stubWfGraphRuntime()
);

function refundNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType: REFUND_ACTION_ID },
    },
  };
}

/** Lifecycle, a refund, a one-hour Wait, and a second refund. */
const graph = createSerializedWorkflowGraph({
  nodes: [
    {
      id: "lifecycle_1",
      type: "lifecycle",
      position: { x: 0, y: 0 },
      data: { label: "Lifecycle", type: "lifecycle", config: {} },
    },
    refundNode("refund_1"),
    {
      id: "wait_1",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Wait",
        type: "action",
        config: { actionType: "Wait", waitMode: "delay", waitDuration: "1h" },
      },
    },
    refundNode("refund_2"),
  ],
  edges: [
    {
      id: "edge_1",
      source: "lifecycle_1",
      sourceHandle: "started",
      target: "refund_1",
    },
    { id: "edge_2", source: "refund_1", target: "wait_1" },
    { id: "edge_3", source: "wait_1", target: "refund_2" },
  ],
});

export function defineHostActionMemoReplayCases(
  executor: ReplayExecutor
): void {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    refunds.length = 0;
    keys.length = 0;
  });

  it("calls a host handler once across the passes of a run that parks below it", async () => {
    const run = await driveWithReplay(
      (runtime) =>
        executeWorkflow(
          { graph, executionId: "exec_memo", workflowId: "workflow_memo" },
          runtime,
          store,
          actions
        ),
      { executor, waitRows: store }
    );

    expect(run.value.status).toBe("completed");
    expect(run.invocations).toBeGreaterThan(1);
    expect(refunds).toEqual(["refund_1", "refund_2"]);
    expect(keys).toEqual(["exec_memo:refund_1", "exec_memo:refund_2"]);
    expect(
      run.executed
        .map((step) => step.stepId)
        .filter((stepId) => stepId.endsWith(":handler"))
    ).toEqual(["node:refund_1:handler", "node:refund_2:handler"]);
  });
}
