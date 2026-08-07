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
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { defineAction } from "#src/backend/extensions/define-action";
import { defineIntegration } from "#src/backend/extensions/define-integration";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";

const EMAIL_ACTION_ID = "test/replay-email";
const FOLLOWUP_ACTION_ID = "test/replay-followup";
const BRANCH_ACTION_ID = "test/replay-branch";

/**
 * Runtime whose memo survives across calls, which is what makes the second
 * call a replay of the first rather than a fresh run.
 *
 * A replay after a wait keeps the attempt it had. Raise `attempt` to model a
 * retry instead, which is what lets a node's row be closed a second time.
 */
function createReplayRuntime(memo: Map<string, unknown>, attempt = 0) {
  return createInMemoryWorkflowRuntime({ memo, skipSleep: true, attempt });
}

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

/**
 * A host action whose work is inside `step.run`, which is the whole of what
 * makes it happen once across a replay. Workflow Graph wraps no handler body.
 */
function aHostAction(
  id: string,
  label: string,
  work: () => Record<string, unknown>
) {
  return defineAction({
    id,
    label,
    description: `Test ${label} action`,
    input: Schema.Struct({}),
    handler: (bag) => bag.step.run("work", () => Promise.resolve(work())),
  });
}

/** The same action with its work left unwrapped, which a replay repeats. */
function anUnwrappedHostAction(
  id: string,
  label: string,
  work: () => Record<string, unknown>
) {
  return defineAction({
    id,
    label,
    description: `Test ${label} action`,
    input: Schema.Struct({}),
    handler: work,
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
    stubWfGraphRuntime()
  );

  beforeEach(() => {
    store = createRecordingWorkflowStore();

    emailAction.mockClear();
    followupAction.mockClear();
    branchAction.mockClear();
  });

  // Lifecycle -> Send Email -> Wait -> Send Followup, the shape that produced
  // ["send-email", "send-email", "send-followup"] before node work was memoized.
  const waitGraphInput = {
    graph: createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createActionNode("email_1", EMAIL_ACTION_ID, "Send Email"),
        createDelayWaitNode("wait_1"),
        createActionNode("followup_1", FOLLOWUP_ACTION_ID, "Send Followup"),
      ],
      edges: [
        {
          id: "edge_1",
          source: "lifecycle_1",
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

    // What a node memoizes is its own run-log rows and whatever its handler put
    // in `step.run`, each under that node's id. Nothing wraps the handler body.
    expect(memo.has("node:email_1:log-open")).toBe(true);
    // The close is deliberately not memoized: it is an UPDATE by id, so the row
    // carries the latest attempt's verdict rather than the first one's.
    expect(memo.has("node:email_1:log-close")).toBe(false);
    expect(memo.has("node:email_1:work")).toBe(true);
    expect(memo.has("node:followup_1:work")).toBe(true);
    expect(memo.has("node:lifecycle_1:log-open")).toBe(true);
    // A Wait node suspends the run, so a step cannot contain it. Its own
    // persistence segments are memoized around the suspension instead.
    expect(memo.has("node:wait_1:log-open")).toBe(false);
    expect(memo.has("wait-delay-prepare-wait_1")).toBe(true);
    expect(memo.has("wait-delay-resume-wait_1")).toBe(true);
  });

  // The other half of the contract, and the trap worth knowing: Workflow Graph wraps no
  // handler body, so work left outside `step.run` happens again on every attempt
  // while the node's log rows stay memoized. The run panel then shows one row for
  // however many times the work ran.
  it("repeats an unwrapped handler on a replay, under one log row", async () => {
    const unwrapped = vi.fn<() => Record<string, unknown>>(() => ({
      sent: true,
    }));
    const bare = createWorkflowActions(
      assembleExtensions({
        actions: [
          anUnwrappedHostAction(EMAIL_ACTION_ID, "Send Email", unwrapped),
          aHostAction(FOLLOWUP_ACTION_ID, "Send Followup", followupAction),
        ],
      }),
      stubWfGraphRuntime()
    );
    const memo = new Map<string, unknown>();

    await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo),
      store,
      bare
    );
    await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo),
      store,
      bare
    );

    expect(unwrapped).toHaveBeenCalledTimes(2);
    expect(memo.has("node:email_1:work")).toBe(false);
    // One row all the same, because the two writes around the handler are steps.
    expect(memo.has("node:email_1:log-open")).toBe(true);
  });

  /**
   * A node that failed and then succeeded on a second pass of the body, which is
   * what a retry of the whole function produces.
   *
   * The node's row carries the second verdict, because its close is an UPDATE by
   * id that no memo covers. The run's terminal row carries the first and cannot
   * be moved: that write is a memoized step, and `finishRun` updates an in-flight
   * row alone, so the correction is refused twice over. That is the whole reason
   * `workflow-function.ts` ends a failed run non-retriably.
   */
  it("closes a node's row with the later verdict, while the run row keeps the first", async () => {
    let attempts = 0;
    const flaky = vi.fn<() => Record<string, unknown>>(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("the vendor said no");
      }
      return { sent: true };
    });
    const flakyActions = createWorkflowActions(
      assembleExtensions({
        actions: [
          aHostAction(EMAIL_ACTION_ID, "Send Email", flaky),
          aHostAction(FOLLOWUP_ACTION_ID, "Send Followup", followupAction),
        ],
      }),
      stubWfGraphRuntime()
    );
    const memo = new Map<string, unknown>();

    const first = await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo),
      store,
      flakyActions
    );
    // The node failed, so what follows is Inngest retrying the body rather than
    // replaying it, and the attempt rises with it.
    const second = await executeWorkflow(
      waitGraphInput,
      createReplayRuntime(memo, 1),
      store,
      flakyActions
    );

    expect(first.success).toBe(false);
    expect(second.success).toBe(true);

    // Handles are handed out in order, so the row opened for the email node is
    // the one its two closes name.
    const emailRowIndex = store
      .callsOf("startStepLog")
      .findIndex((open) => open.nodeId === "email_1");
    const emailRowId = `log_${emailRowIndex + 1}`;
    const emailCloses = store
      .callsOf("completeStepLog")
      .filter((close) => close.logId === emailRowId);

    expect(emailCloses.map((close) => close.status)).toEqual([
      "error",
      "success",
    ]);
    expect(store.callsOf("completeRun").map((run) => run.status)).toEqual([
      "failed",
    ]);
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
          createLifecycleNode("lifecycle_1"),
          createActionNode("fanout_1", BRANCH_ACTION_ID, "Fan Out"),
          createActionNode("left_1", BRANCH_ACTION_ID, "Left Branch"),
          createActionNode("right_1", BRANCH_ACTION_ID, "Right Branch"),
        ],
        edges: [
          {
            id: "edge_1",
            source: "lifecycle_1",
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
    expect(memo.has("node:left_1:work")).toBe(true);
    expect(memo.has("node:right_1:work")).toBe(true);

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
    credentials: {},
    actions: {
      "read-clock": {
        label: "Read Clock",
        description: "Answers with the time it read",
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
        // Deliberately outside `step.run`: reading a clock is pure, and a `Date`
        // put through a step comes back a string on the replay, which the output
        // schema's encode then refuses.
        handler: Effect.fn(function* () {
          return yield* Effect.succeed({
            at: new Date("2026-03-01T10:00:00Z"),
          });
        }),
      },
      "echo-clock": {
        label: "Echo",
        description: "Records what the template resolved to",
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
        handler: Effect.fn(function* (bag) {
          return yield* bag.step.run(
            "record",
            Effect.sync(() => {
              echoed.push(bag.input.seen);
              return { seen: bag.input.seen };
            })
          );
        }),
      },
    },
  });

  // Echo reads the timestamp on the attempt that ran the clock; Echo Again reads
  // it out of the memo after the wait. Both must see the same string.
  const clockGraphInput = {
    graph: createSerializedWorkflowGraph({
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createActionNode("clock_1", CLOCK_ACTION_ID, "Read Clock"),
        createEchoNode("echo_1", "Echo"),
        createDelayWaitNode("wait_1"),
        createEchoNode("echo_2", "Echo Again"),
      ],
      edges: [
        {
          id: "edge_1",
          source: "lifecycle_1",
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
    stubWfGraphRuntime()
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
