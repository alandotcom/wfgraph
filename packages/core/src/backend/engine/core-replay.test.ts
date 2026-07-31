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

import { Effect, Schema, SchemaTransformation } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import type { WorkflowNode } from "@rova/shared/graph/types";
import { defineAction } from "#src/backend/extensions/define-action";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { stubRovaRuntime } from "#src/backend/lib/effect/test-layers";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { defineStep } from "#src/backend/extensions/steps/define-step";
import { executeWorkflow } from "./core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "./recording-store";
import { createInMemoryWorkflowRuntime } from "./runtime";

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
      config: {},
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

const emailAction = vi.fn<() => Record<string, unknown>>(() => ({
  sent: true,
}));
const followupAction = vi.fn<() => Record<string, unknown>>(() => ({
  sent: true,
}));
const branchAction = vi.fn<() => Record<string, unknown>>(() => ({ ok: true }));

function aHostAction(
  id: string,
  label: string,
  handler: () => Record<string, unknown>
) {
  return defineAction({
    id,
    label,
    description: `Test ${label} action`,
    input: Schema.Struct({}),
    handler,
  });
}

describe("workflow engine replay safety", () => {
  let store: RecordingWorkflowStore;

  // The engine reaches an action's step and its label through the dispatch port
  // the app builds, so the three host actions these cases run reach the engine
  // the way a host's own would.
  const actions = createWorkflowActions(
    assembleExtensions({
      actions: [
        aHostAction(EMAIL_ACTION_ID, "Send Email", emailAction),
        aHostAction(FOLLOWUP_ACTION_ID, "Send Followup", followupAction),
        aHostAction(BRANCH_ACTION_ID, "Branch Action", branchAction),
      ],
    }),
    stubRovaRuntime()
  );

  beforeEach(() => {
    store = createRecordingWorkflowStore();

    emailAction.mockClear();
    followupAction.mockClear();
    branchAction.mockClear();
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
        {
          id: "edge_1",
          source: "trigger_1",
          sourceHandle: "started",
          target: "email_1",
        },
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
      store,
      actions
    );
    // Second pass with the same memo is the replay after the wait resumes.
    const second = await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo),
      store,
      actions
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
      store,
      actions
    );
    await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(new Map<string, unknown>()),
      store,
      actions
    );

    expect(emailAction).toHaveBeenCalledTimes(2);
  });

  it("memoizes each node under its own node id", async () => {
    const memo = new Map<string, unknown>();

    await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo),
      store,
      actions
    );

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

    await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo),
      store,
      actions
    );
    await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo),
      store,
      actions
    );

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
          {
            id: "edge_1",
            source: "trigger_1",
            sourceHandle: "started",
            target: "fanout_1",
          },
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
      store,
      actions
    );

    expect(first.success).toBe(true);
    expect(branchAction).toHaveBeenCalledTimes(3);
    expect(memo.has("node:left_1")).toBe(true);
    expect(memo.has("node:right_1")).toBe(true);

    await executeWorkflow(
      fanOutInput,
      createReplayRuntime(memo),
      store,
      actions
    );

    expect(branchAction).toHaveBeenCalledTimes(3);
  });
});

/**
 * A node output holding a `Date` is the worst thing this engine can carry: it
 * survives JSONB and Inngest's own serialization by accident, through
 * `Date.prototype.toJSON`, and comes back a string on replay. The same memoized
 * step would then hand template resolution and CEL a `Date` on the attempt that
 * ran it and a string on every attempt after.
 *
 * `defineStep` encodes a handler's answer through the schema's canonical JSON
 * codec before the envelope, so what leaves a step is already the string. This
 * case reads the value back the way a workflow does, through a template in a
 * downstream node's config: once on the attempt that ran the step, and once on the
 * replay that read it out of the memo. The runtime's own asymmetry is what makes
 * the two passes different -- see `createInMemoryWorkflowRuntime`.
 */
describe("a Date-bearing step output across a replay", () => {
  // Any declared integration type will do: what this exercises is the output
  // schema, not the vendor.
  const CLOCK_ACTION_ID = "acuity/read-clock";
  const ECHO_ACTION_ID = "acuity/echo-clock";
  const AT_TOKEN = "{{@clock_1:Read Clock.at}}";

  /** What each Echo node resolved the template to, in the order they ran. */
  let echoed: string[] = [];

  const clock = defineIntegration({
    type: "acuity",
    label: "Clock",
    description: "Answers with a timestamp",
    credentials: [],
    actions: {
      "read-clock": defineStep({
        label: "Read Clock",
        description: "Answers with the time it read",
        category: "Clock",
        input: Schema.Struct({}),
        output: Schema.Struct({
          at: Schema.String.annotate({
            description: "When it was read",
            format: "date-time",
          }).pipe(
            Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
          ),
        }),
        configFields: [],
        handler: Effect.fn(function* () {
          return yield* Effect.succeed({
            at: new Date("2026-03-01T10:00:00Z"),
          });
        }),
      }),
      "echo-clock": defineStep({
        label: "Echo",
        description: "Records what the template resolved to",
        category: "Clock",
        input: Schema.Struct({ seen: Schema.String }),
        output: Schema.Struct({
          seen: Schema.String.annotate({ description: "What it was handed" }),
        }),
        configFields: [
          {
            key: "seen",
            label: "Seen",
            type: "template-input",
            required: true,
          },
        ],
        handler: Effect.fn(function* (config) {
          echoed.push(config.seen);
          return yield* Effect.succeed({ seen: config.seen });
        }),
      }),
    },
  });

  // Echo reads the timestamp on the attempt that ran the clock; Echo Again reads
  // it out of the memo after the wait. Both must see the same string.
  const clockGraphInput = {
    graph: createSerializedWorkflowGraph({
      nodes: [
        createTriggerNode("trigger_1"),
        createActionNode("clock_1", CLOCK_ACTION_ID, "Read Clock"),
        createEchoNode("echo_1", "Echo"),
        createDelayWaitNode("wait_1"),
        createEchoNode("echo_2", "Echo Again"),
      ],
      edges: [
        {
          id: "edge_1",
          source: "trigger_1",
          sourceHandle: "started",
          target: "clock_1",
        },
        { id: "edge_2", source: "clock_1", target: "echo_1" },
        { id: "edge_3", source: "echo_1", target: "wait_1" },
        { id: "edge_4", source: "wait_1", target: "echo_2" },
      ],
    }),
    executionId: "exec_clock",
    workflowId: "workflow_clock",
  };

  function createEchoNode(id: string, label: string): WorkflowNode {
    return {
      id,
      type: "action",
      position: { x: 0, y: 0 },
      data: {
        label,
        type: "action",
        config: { actionType: ECHO_ACTION_ID, seen: AT_TOKEN },
      },
    };
  }

  const actions = createWorkflowActions(
    assembleExtensions({ integrations: [clock] }),
    stubRovaRuntime()
  );

  beforeEach(() => {
    echoed = [];
  });

  it("resolves the same ISO string before and after the replay", async () => {
    const memo = new Map<string, unknown>();
    const store = createRecordingWorkflowStore();

    const first = await executeWorkflow(
      clockGraphInput,
      createReplayRuntime(memo),
      store,
      actions
    );
    const second = await executeWorkflow(
      clockGraphInput,
      createReplayRuntime(memo),
      store,
      actions
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(echoed).toEqual([
      "2026-03-01T10:00:00.000Z",
      "2026-03-01T10:00:00.000Z",
    ]);
  });
});
