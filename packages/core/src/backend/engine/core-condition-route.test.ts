/**
 * A Condition decides its route once. Its expression can read values that move
 * between passes, such as CEL's `now`, and a pass replays the body from the
 * top, so the route the first pass took has to be the one every later pass
 * reads, or a run parked below one branch resumes down the other.
 */

import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { readJsonObjectLeniently } from "@wfgraph/shared/types/json";
import type { WorkflowActions } from "#src/backend/engine/actions";
import { createRecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";
import {
  createLifecycleNode,
  createWaitNode,
} from "#src/backend/engine/testing/wait-fixtures";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-01-01T00:00:00.000Z");

function actionNode(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config: { actionType: "test/send" } },
  };
}

/**
 * An action whose work, inside `step.run`, records the node it ran for, so a
 * replay answers it from the memo and records nothing.
 */
function recordingActions(ran: string[]): WorkflowActions {
  return {
    stepFor: () => (input, steps) =>
      Effect.promise(async () => {
        const context = readJsonObjectLeniently(input._context);
        const record = () => {
          ran.push(String(context?.nodeId));
          return Promise.resolve({ sent: true });
        };
        const data = steps ? await steps.run("send", record) : await record();
        return { success: true as const, data };
      }),
    metadataFor: () => ({
      label: "Send",
      literalConfigKeys: [],
      templateJsonConfigShapes: [],
    }),
    catalogFingerprint: () => "catalog",
  };
}

/**
 * Lifecycle -> Condition (true until a day after the start) -> true: reminder
 * -> Wait 2d -> follow-up, false: cancel notice.
 */
const graph = createSerializedWorkflowGraph({
  nodes: [
    createLifecycleNode("lifecycle_1"),
    {
      id: "condition_1",
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label: "Starts soon",
        type: "action",
        config: {
          actionType: "Condition",
          condition: `now < timestamp("${new Date(START + DAY_MS).toISOString()}")`,
        },
      },
    },
    actionNode("reminder"),
    createWaitNode("wait_1", { waitMode: "delay", waitDuration: "2d" }),
    actionNode("follow_up"),
    actionNode("cancel_notice"),
  ],
  edges: [
    {
      id: "edge_condition",
      source: "lifecycle_1",
      sourceHandle: "started",
      target: "condition_1",
    },
    {
      id: "edge_true",
      source: "condition_1",
      sourceHandle: "true",
      target: "reminder",
    },
    {
      id: "edge_false",
      source: "condition_1",
      sourceHandle: "false",
      target: "cancel_notice",
    },
    { id: "edge_wait", source: "reminder", target: "wait_1" },
    { id: "edge_follow_up", source: "wait_1", target: "follow_up" },
  ],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

it("routes every pass the way the first pass decided, after the expression has changed its answer", async () => {
  const store = createRecordingWorkflowStore();
  const ran: string[] = [];

  const run = await driveWithReplay(
    (runtime, pass) => {
      // The second pass runs once the Wait's two days are up, when `now` is
      // past the Condition's cutoff and the expression answers false.
      vi.setSystemTime(START + pass.invocation * (2 * DAY_MS + 1));
      return executeTestWorkflow(
        {
          graph,
          executionId: "exec_route",
          workflowId: "workflow_route",
        },
        runtime,
        store,
        recordingActions(ran)
      );
    },
    { waitRows: store }
  );

  expect(run.invocations).toBe(2);
  expect(run.value.status).toBe("completed");
  expect(ran).toEqual(["reminder", "follow_up"]);
  expect(run.value.results.cancel_notice).toBeUndefined();
});
