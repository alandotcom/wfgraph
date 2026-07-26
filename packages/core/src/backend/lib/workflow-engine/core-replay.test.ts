/**
 * Regression tests for durable replay.
 *
 * A durable runtime (Inngest) re-runs the whole workflow function body every
 * time a run resumes after a wait. Only work handed to `runtime.step` is
 * remembered, so anything else would fire its side effect again on every
 * resume. These tests model that with a fake runtime whose `step` memoizes by
 * id, then drive the engine twice against the same memo: the second pass is the
 * replay, and nodes that already ran must not run again.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  type RuntimeActionResult,
  registerRuntimeAction,
  unregisterRuntimeAction,
} from "@/shared/workflow/action-registry";
import { createSerializedWorkflowGraph } from "@/shared/workflow/graph";
import type { WorkflowNode } from "@/shared/workflow/types";
import { executeWorkflow } from "./core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "./recording-store";
import { createInMemoryWorkflowRuntime } from "./runtime";

// Per-action step logs still go through step-handler's withStepLogging, which
// is not behind the store port; this stub keeps that path off a database.
mock.module("@/backend/lib/workflow-logging", () => ({
  logStepStartDb: () =>
    Promise.resolve({ logId: "mock-log-id", startTime: Date.now() }),
  logStepCompleteDb: () => Promise.resolve(),
  logWorkflowCompleteDb: () => Promise.resolve(),
}));

const EMAIL_ACTION_ID = "test/replay-email";
const FOLLOWUP_ACTION_ID = "test/replay-followup";
const BRANCH_ACTION_ID = "test/replay-branch";

/**
 * Runtime whose memo survives across calls, which is what makes the second
 * call a replay of the first rather than a fresh run.
 */
function createReplayRuntime(memo: Map<string, unknown>) {
  return createInMemoryWorkflowRuntime({ memo, skipSleep: true });
}

function createTriggerNode(id: string): WorkflowNode {
  return {
    id,
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      label: "Trigger",
      type: "trigger",
      config: { triggerType: "Trigger" },
    },
  };
}

function createActionNode(
  id: string,
  actionType: string,
  label: string
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label,
      type: "action",
      config: { actionType },
    },
  };
}

function createDelayWaitNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Wait",
      type: "action",
      config: {
        actionType: "Wait",
        waitMode: "delay",
        waitDuration: "1s",
      },
    },
  };
}

const emailAction = mock<() => RuntimeActionResult>(() => ({
  success: true,
  data: { sent: true },
}));
const followupAction = mock<() => RuntimeActionResult>(() => ({
  success: true,
  data: { sent: true },
}));
const branchAction = mock<() => RuntimeActionResult>(() => ({
  success: true,
  data: { ok: true },
}));

describe("workflow engine replay safety", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
    registerRuntimeAction({
      id: EMAIL_ACTION_ID,
      label: "Send Email",
      description: "Test email action",
      execute: emailAction,
    });
    registerRuntimeAction({
      id: FOLLOWUP_ACTION_ID,
      label: "Send Followup",
      description: "Test followup action",
      execute: followupAction,
    });
    registerRuntimeAction({
      id: BRANCH_ACTION_ID,
      label: "Branch Action",
      description: "Test fan-out action",
      execute: branchAction,
    });

    emailAction.mockClear();
    followupAction.mockClear();
    branchAction.mockClear();
  });

  afterEach(() => {
    unregisterRuntimeAction(EMAIL_ACTION_ID);
    unregisterRuntimeAction(FOLLOWUP_ACTION_ID);
    unregisterRuntimeAction(BRANCH_ACTION_ID);
  });

  // Trigger -> Send Email -> Wait -> Send Followup, the shape that produced
  // ["send-email", "send-email", "send-followup"] before node work was memoized.
  const waitGraphInput = {
    graph: createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createActionNode("email_1", EMAIL_ACTION_ID, "Send Email"),
        createDelayWaitNode("wait_1"),
        createActionNode("followup_1", FOLLOWUP_ACTION_ID, "Send Followup"),
      ],
      edges: [
        { id: "edge_1", source: "trigger_1", target: "email_1" },
        { id: "edge_2", source: "email_1", target: "wait_1" },
        { id: "edge_3", source: "wait_1", target: "followup_1" },
      ],
    }),
    executionId: "exec_replay",
    workflowId: "workflow_replay",
  };

  it("runs a node upstream of a Wait exactly once across a replay", async () => {
    const memo = new Map<string, unknown>();

    const first = await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo),
      store
    );
    // Second pass with the same memo is the replay after the wait resumes.
    const second = await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo),
      store
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(emailAction).toHaveBeenCalledTimes(1);
    expect(followupAction).toHaveBeenCalledTimes(1);
  });

  it("re-runs everything without a memo, proving the memo is what prevents it", async () => {
    await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(new Map<string, unknown>()),
      store
    );
    await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(new Map<string, unknown>()),
      store
    );

    expect(emailAction).toHaveBeenCalledTimes(2);
  });

  it("memoizes each node under its own node id", async () => {
    const memo = new Map<string, unknown>();

    await executeWorkflow(waitGraphInput, createReplayRuntime(memo), store);

    expect(memo.has("node:trigger_1")).toBe(true);
    expect(memo.has("node:email_1")).toBe(true);
    expect(memo.has("node:followup_1")).toBe(true);
    // The Wait node itself is never wrapped - it suspends the run, and a step
    // cannot contain a sleep. Its persistence segments are memoized instead.
    expect(memo.has("node:wait_1")).toBe(false);
    expect(memo.has("wait-delay-prepare-wait_1")).toBe(true);
    expect(memo.has("wait-delay-resume-wait_1")).toBe(true);
  });

  it("creates the wait state and terminal run record exactly once across a replay", async () => {
    const memo = new Map<string, unknown>();

    await executeWorkflow(waitGraphInput, createReplayRuntime(memo), store);
    await executeWorkflow(waitGraphInput, createReplayRuntime(memo), store);

    expect(store.callsOf("createWaitState")).toHaveLength(1);
    expect(store.callsOf("completeRun")).toHaveLength(1);
  });

  it("runs both branches of a fan-out once each, and not again on replay", async () => {
    const fanOutInput = {
      graph: createSerializedWorkflowGraph({
        nodes: [
          createTriggerNode("trigger_1"),
          createActionNode("fanout_1", BRANCH_ACTION_ID, "Fan Out"),
          createActionNode("left_1", BRANCH_ACTION_ID, "Left Branch"),
          createActionNode("right_1", BRANCH_ACTION_ID, "Right Branch"),
        ],
        edges: [
          { id: "edge_1", source: "trigger_1", target: "fanout_1" },
          { id: "edge_2", source: "fanout_1", target: "left_1" },
          { id: "edge_3", source: "fanout_1", target: "right_1" },
        ],
      }),
      executionId: "exec_fanout",
      workflowId: "workflow_fanout",
    };

    const memo = new Map<string, unknown>();
    const first = await executeWorkflow(
      fanOutInput,
      createReplayRuntime(memo),
      store
    );

    expect(first.success).toBe(true);
    expect(branchAction).toHaveBeenCalledTimes(3);
    expect(memo.has("node:left_1")).toBe(true);
    expect(memo.has("node:right_1")).toBe(true);

    await executeWorkflow(fanOutInput, createReplayRuntime(memo), store);

    expect(branchAction).toHaveBeenCalledTimes(3);
  });
});
