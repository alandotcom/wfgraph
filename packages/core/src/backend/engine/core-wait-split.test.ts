/**
 * Event Split below a Wait: the Wait is an Arriving Event source, so the split
 * routes on the Event that woke it, not the Start Event that put the run there.
 * A timeout that continues names none, and a branch run must hand the payload
 * overwrite back to the run that started it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  compileConditionModel,
  EVENT_NAME_FIELD_PATH,
  serializeConditionModel,
  type ConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { noWorkflowActions } from "#src/backend/engine/actions";
import { executionData } from "#src/backend/engine/contracts";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import {
  executeTestWorkflow as executeWorkflow,
  executeTestWorkflowBranch as executeWorkflowBranch,
} from "#src/backend/engine/test-execution";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";

const SETTLED = "billing/payment.settled";
const FAILED = "billing/payment.failed";
const CREATED = "app/appointment.created";

function createLifecycleNode(id: string): WorkflowNode {
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

function createConditionNode(
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

function eventNameEqualsModel(eventName: string): ConditionModel {
  return {
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group-1",
        logic: "and",
        conditions: [
          {
            id: "condition-1",
            field: EVENT_NAME_FIELD_PATH,
            fieldType: "string",
            operator: "equals",
            value: eventName,
          },
        ],
      },
    ],
  };
}

function createEventNameConditionNode(
  id: string,
  eventName: string
): WorkflowNode {
  const model = eventNameEqualsModel(eventName);
  const compiled = compileConditionModel(model);
  if (!compiled.valid) {
    throw new Error(compiled.error);
  }
  return createConditionNode(
    id,
    compiled.expression,
    serializeConditionModel(model)
  );
}

function waitResumeSignal(eventType: string, payload: Record<string, string>) {
  return {
    name: "workflow/wait.signal",
    id: "evt_signal",
    ts: 0,
    data: {
      executionId: "exec_wait_split",
      nodeId: "wait_1",
      token: "token_1",
      eventType,
      signalType: "wait-resume",
      payload,
    },
  };
}

function createWaitSplitGraph() {
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

describe("executeWorkflow Event Split after Wait", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("runs the branch belonging to the Event that woke the Wait", async () => {
    const result = await executeWorkflow(
      {
        graph: createWaitSplitGraph(),
        executionId: "exec_wait_split",
        workflowId: "workflow_wait_split",
        startEventName: CREATED,
        startPayload: { appointmentId: "appt_1" },
      },
      createInMemoryWorkflowRuntime({
        resumeEvent: waitResumeSignal(SETTLED, { amount: "40" }),
      }),
      store,
      noWorkflowActions
    );

    expect(result.success).toBe(true);
    expect(result.results.on_settled?.success).toBe(true);
    expect(result.results.on_failed).toBeUndefined();
    // The Start Event put the run at the Wait; it is not what the split below
    // routes on, even when that outlet is wired.
    expect(result.results.on_created).toBeUndefined();
    expect(executionData(result.results.split_1)).toEqual({
      success: true,
      data: { event: SETTLED },
    });
    // The entry node's output is the payload that woke the Wait, matching the
    // Events the editor now offers below it.
    expect(result.outputs.lifecycle_1?.data).toEqual({ amount: "40" });
  });

  it("still splits on the Start Event after a delay Wait", async () => {
    const result = await executeWorkflow(
      {
        graph: createSerializedWorkflowGraph({
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
                  waitMode: "delay",
                  waitDuration: "1s",
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
            createConditionNode("on_created", true),
            createConditionNode("on_settled", true),
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
              id: "edge_s_created",
              source: "split_1",
              sourceHandle: eventSplitOutlet(CREATED),
              target: "on_created",
            },
            {
              id: "edge_s_settled",
              source: "split_1",
              sourceHandle: eventSplitOutlet(SETTLED),
              target: "on_settled",
            },
          ],
        }),
        executionId: "exec_delay_split",
        workflowId: "workflow_delay_split",
        startEventName: CREATED,
        startPayload: { appointmentId: "appt_1" },
      },
      createInMemoryWorkflowRuntime({ skipSleep: true }),
      store,
      noWorkflowActions
    );

    expect(result.success).toBe(true);
    expect(result.results.on_created?.success).toBe(true);
    expect(result.results.on_settled).toBeUndefined();
    expect(result.outputs.lifecycle_1?.data).toEqual({
      appointmentId: "appt_1",
    });
  });

  it("does not keep the Start Event after an event Wait times out and continues", async () => {
    const result = await executeWorkflow(
      {
        graph: createSerializedWorkflowGraph({
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
                  waitTimeoutBehavior: "continue",
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
            createEventNameConditionNode("which_event", CREATED),
            createConditionNode("on_settled", true),
            createConditionNode("on_created", true),
            createConditionNode("name_is_start", true),
            createConditionNode("name_is_not_start", true),
          ],
          edges: [
            {
              id: "edge_l_w",
              source: "lifecycle_1",
              sourceHandle: "started",
              target: "wait_1",
            },
            { id: "edge_w_s", source: "wait_1", target: "split_1" },
            { id: "edge_w_which", source: "wait_1", target: "which_event" },
            {
              id: "edge_s_settled",
              source: "split_1",
              sourceHandle: eventSplitOutlet(SETTLED),
              target: "on_settled",
            },
            {
              id: "edge_s_created",
              source: "split_1",
              sourceHandle: eventSplitOutlet(CREATED),
              target: "on_created",
            },
            {
              id: "edge_which_true",
              source: "which_event",
              sourceHandle: "true",
              target: "name_is_start",
            },
            {
              id: "edge_which_false",
              source: "which_event",
              sourceHandle: "false",
              target: "name_is_not_start",
            },
          ],
        }),
        executionId: "exec_wait_timeout",
        workflowId: "workflow_wait_timeout",
        startEventName: CREATED,
        startPayload: { appointmentId: "appt_1" },
      },
      createInMemoryWorkflowRuntime({ resumeEvent: null }),
      store,
      noWorkflowActions
    );

    expect(result.success).toBe(true);
    expect(result.results.on_created).toBeUndefined();
    expect(result.results.on_settled).toBeUndefined();
    expect(result.results.name_is_start).toBeUndefined();
    expect(result.results.name_is_not_start?.success).toBe(true);
    expect(executionData(result.results.split_1)).toEqual({
      success: true,
      data: { event: null },
    });
    expect(result.outputs.lifecycle_1?.data).toEqual({});
  });

  it("overwrites the entry payload on a branch run so the parent sees the Wait's Event", async () => {
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
          "wait-event-wait_1": waitResumeSignal(SETTLED, { amount: "40" }),
        },
        branch: (runtime, branchInput) =>
          executeWorkflowBranch(
            { ...input, ...branchInput },
            runtime,
            store,
            noWorkflowActions
          ),
      }
    );

    const result = run.value;
    expect(result.success).toBe(true);
    expect(result.results.on_settled?.success).toBe(true);
    expect(result.results.on_failed).toBeUndefined();
    expect(result.results.on_created).toBeUndefined();
    expect(executionData(result.results.split_1)).toEqual({
      success: true,
      data: { event: SETTLED },
    });
    expect(result.outputs.lifecycle_1?.data).toEqual({ amount: "40" });
  });
});
