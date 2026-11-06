/**
 * The Event Split graph the Wait-split suite drives, and its case: a Wait woken
 * by an Event hands that Event's payload to the entry node.
 */

import { expect, it } from "vitest";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { noWorkflowActions } from "#src/backend/engine/actions";
import { executionData } from "#src/backend/engine/contracts";
import type { WaitWake } from "#src/backend/engine/runtime";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import {
  driveWithReplay,
  type ReplayExecutor,
} from "#src/backend/engine/testing/replay-runtime";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";

export const SETTLED = "billing/payment.settled";
export const FAILED = "billing/payment.failed";
export const CREATED = "app/appointment.created";

export function createLifecycleNode(id: string): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: {
      label: "Lifecycle",
      type: "lifecycle",
      config: {},
    },
  };
}

export function createConditionNode(
  id: string,
  condition: boolean | string,
  conditionModel?: string
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 100, y: 100 },
    data: {
      label: id,
      type: "action",
      config: {
        actionType: "Condition",
        condition,
        conditionModel,
      },
    },
  };
}

export function waitResumeSignal(
  eventType: string,
  payload: Record<string, string>
): WaitWake {
  return { kind: "resume", eventName: eventType, payload };
}

export function createWaitSplitGraph() {
  return createSerializedWorkflowGraph({
    nodes: [
      createLifecycleNode("lifecycle_1"),
      {
        id: "wait_1",
        type: "action",
        position: { x: 0, y: 100 },
        data: {
          label: "Wait",
          type: "action",
          config: {
            actionType: BUILT_IN_ACTION_IDS.wait,
            waitMode: "event",
            waitFor: [{ event: SETTLED }, { event: FAILED }],
            waitTimeout: "7d",
          },
        },
      },
      {
        id: "split_1",
        type: "action",
        position: { x: 0, y: 200 },
        data: {
          label: "Split on Event",
          type: "action",
          config: { actionType: BUILT_IN_ACTION_IDS.eventSplit },
        },
      },
      createConditionNode("on_settled", true),
      createConditionNode("on_failed", true),
      createConditionNode("on_created", true),
    ],
    edges: [
      {
        id: "edge_l_w",
        source: "lifecycle_1",
        sourceHandle: "started",
        target: "wait_1",
      },
      { id: "edge_w_s", source: "wait_1", target: "split_1" },
      {
        id: "edge_s_settled",
        source: "split_1",
        sourceHandle: eventSplitOutlet(SETTLED),
        target: "on_settled",
      },
      {
        id: "edge_s_failed",
        source: "split_1",
        sourceHandle: eventSplitOutlet(FAILED),
        target: "on_failed",
      },
      {
        id: "edge_s_created",
        source: "split_1",
        sourceHandle: eventSplitOutlet(CREATED),
        target: "on_created",
      },
    ],
  });
}

export function defineWaitSplitReplayCases(executor: ReplayExecutor): void {
  // The pass that resumes the Wait overwrites the entry payload in its own
  // traversal, so the run's result carries the Wait's Event.
  it("overwrites the entry payload so the run's result carries the Wait's Event", async () => {
    const store = createRecordingWorkflowStore();
    const input = {
      graph: createWaitSplitGraph(),
      executionId: "exec_wait_split",
      workflowId: "workflow_wait_split",
      startEventName: CREATED,
      startPayload: { appointmentId: "appt_1" },
    };

    const run = await driveWithReplay(
      (runtime) => executeWorkflow(input, runtime, store, noWorkflowActions),
      {
        events: {
          "wait-park-wait_1-0": waitResumeSignal(SETTLED, { amount: "40" }),
        },
        executor,
      }
    );

    const result = run.value;
    expect(result).toMatchObject({ kind: "ended", success: true });
    expect(result.results.on_settled?.success).toBe(true);
    expect(result.results.on_failed).toBeUndefined();
    expect(result.results.on_created).toBeUndefined();
    expect(executionData(result.results.split_1)).toEqual({
      success: true,
      data: { event: SETTLED },
    });
    expect(result.outputs.lifecycle_1?.data).toEqual({ amount: "40" });
  });
}
