/**
 * What a Wait node costs the branches beside it.
 *
 * A durable runtime suspends the run rather than the branch, so these cases run
 * through `driveWithReplay` instead of the in-memory runtime: only a driver that
 * calls the body again on a virtual clock can show a branch stopping at a Wait.
 * The graph is the one that surfaced the defect, an entry node whose Started
 * outlet feeds both an Event Split and a Wait.
 *
 * Each case that hands a Wait to a branch run of its own (ADR-0011) under the
 * Inngest executor has a single-run case beside it under the database
 * executor, where every Wait parks in the one run and the run wakes on any
 * resolution.
 */

import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { unknownRest } from "@wfgraph/shared/types/schema";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import type { WorkflowEntities } from "#src/backend/engine/entities";
import type { PendingCancel, WorkflowStore } from "#src/backend/engine/store";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { defineAction } from "#src/backend/extensions/define-action";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { stubWfGraphRuntime } from "#src/backend/lib/effect/test-layers";
import {
  executeTestWorkflow as executeWorkflow,
  executeTestWorkflowBranch as executeWorkflowBranch,
} from "#src/backend/engine/test-execution";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import type { DatabaseReplayExecutor } from "#src/backend/engine/testing/replay-database-executor";
import {
  driveWithReplay,
  type ReplayPass,
} from "#src/backend/engine/testing/replay-runtime";
import {
  CANCEL_WAKE,
  EXIT_WAKE,
} from "#src/backend/engine/testing/wait-fixtures";

const SEND_ACTION_ID = "test/send";
const ECHO_ACTION_ID = "test/echo";
const WRAP_ACTION_ID = "test/wrap";
const START_EVENT = "app/appointment.created";

/**
 * An action whose work sits in a durable step, which is what a real one does
 * with a side effect. The step is the boundary a stalled branch stops at, so a
 * handler doing its work inline would have nothing to observe.
 */
const sendAction = defineAction({
  id: SEND_ACTION_ID,
  label: "Send",
  description: "Runs one durable step",
  input: Schema.Struct({}),
  handler: async ({ step }) => {
    await step.run("dispatch", () => Promise.resolve(null));
    return { sent: true };
  },
});

/**
 * What a `wrap` node answers with: a payload of its own that happens to be
 * shaped like a step envelope, which a vendor body carrying a `success` flag
 * beside its data often is.
 *
 * It is the payload that tells a stored row and an in-run output apart. Every
 * reader steps through one envelope, so read bare this one is stepped through a
 * second time and `id` resolves to nothing.
 */
const WRAPPER_SHAPED_PAYLOAD = {
  success: true,
  data: { note: "envelope" },
  id: "inner",
};

const wrapAction = defineAction({
  id: WRAP_ACTION_ID,
  label: "Wrap",
  description: "Answers with a payload shaped like a step envelope",
  input: Schema.Struct({}),
  handler: () => WRAPPER_SHAPED_PAYLOAD,
});

/** What the last `echo` node was handed, once its templates were resolved. */
let echoedConfig: unknown;

/**
 * An action that records the config it ran with, for the one question a branch
 * run answers differently: what the nodes above its entry left behind.
 */
const echoAction = defineAction({
  id: ECHO_ACTION_ID,
  label: "Echo",
  description: "Records the config it was handed",
  input: Schema.StructWithRest(Schema.Struct({}), unknownRest),
  handler: async ({ input, step }) => {
    await step.run("dispatch", () => Promise.resolve(null));
    echoedConfig = input;
    return {};
  },
});

const actions = createWorkflowActions(
  assembleExtensions({ actions: [sendAction, echoAction, wrapAction] }),
  stubWfGraphRuntime()
);

function lifecycleNode(id: string, config: JsonObject = {}): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Appointments", type: "lifecycle", config },
  };
}

/** Only a graph declaring a Cancel Event ever buys the boundary read. */
const CANCELABLE: JsonObject = {
  lifecycleRules: {
    concurrency: "newest-wins",
    startEvents: [START_EVENT],
    cancelEvents: ["app/appointment.canceled"],
    allowManualStart: true,
  },
};

const ENTITY_CONDITION = JSON.stringify({
  version: 2,
  groupLogic: "and",
  groups: [
    {
      id: "group",
      logic: "and",
      conditions: [
        {
          id: "active",
          field: "active",
          fieldType: "boolean",
          operator: "is_true",
        },
      ],
    },
  ],
});

const GUARDED: JsonObject = {
  lifecycleRules: {
    concurrency: "unlimited",
    startEvents: [START_EVENT],
    cancelEvents: [],
    allowManualStart: false,
    trackedEntity: {
      type: "appointment",
      bindings: { [START_EVENT]: "appointment" },
    },
    entityEligibility: {
      condition: ENTITY_CONDITION,
      checkpoints: ["before-node"],
    },
  },
};

function actionNode(id: string, config: Record<string, unknown>): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config },
  };
}

function sendNode(id: string): WorkflowNode {
  return actionNode(id, { actionType: SEND_ACTION_ID });
}

function waitNode(id: string, waitDuration: string): WorkflowNode {
  return actionNode(id, {
    actionType: BUILT_IN_ACTION_IDS.wait,
    waitMode: "delay",
    waitDuration,
    waitGateMode: "require_actual_wait",
  });
}

/** The clock at which a node's own step ran, or undefined if it never did. */
function dispatchClock(
  executed: ReadonlyArray<{ stepId: string; at: number }>,
  nodeId: string
): number | undefined {
  return executed.find((step) => step.stepId === `node:${nodeId}:dispatch`)?.at;
}

/**
 * Drives one graph the way a live run goes: a root run, and one branch run per
 * Wait the root hands off. Every run writes to the one store, which is how a
 * branch reads the outputs of the nodes above it.
 */
function runGraph(
  graph: ReturnType<typeof createSerializedWorkflowGraph>,
  options: {
    killBranchesAtMs?: number;
    store?: WorkflowStore;
    entities?: WorkflowEntities;
    guarded?: boolean;
  } = {}
) {
  const {
    store = createRecordingWorkflowStore(),
    entities,
    guarded = false,
    ...replayOptions
  } = options;
  const input = {
    graph,
    executionId: "exec_parallel",
    workflowId: "workflow_parallel",
    startEventName: START_EVENT,
    startPayload: { appointment: { id: "123" } },
    ...(guarded
      ? { entityType: "appointment", entityId: "appointment_123" }
      : {}),
  };

  return driveWithReplay(
    (runtime) => executeWorkflow(input, runtime, store, actions, entities),
    {
      executor: {
        kind: "inngest",
        ...replayOptions,
        branch: (runtime, branchInput) =>
          executeWorkflowBranch(
            { ...input, ...branchInput },
            runtime,
            store,
            actions,
            entities
          ),
      },
    }
  );
}

/**
 * Drives one graph the way the database executor runs it: one run per
 * Execution, every Wait entered where it stands, and the body run again from
 * the top whenever one of its parks resolves.
 *
 * `storeForPass` wraps the store one pass writes through, for a case whose
 * store write is also a producer that resolves parks during the pass.
 */
function runGraphInOneRun(
  graph: ReturnType<typeof createSerializedWorkflowGraph>,
  options: {
    store?: WorkflowStore;
    storeForPass?: (store: WorkflowStore, pass: ReplayPass) => WorkflowStore;
    entities?: WorkflowEntities;
    guarded?: boolean;
    signalOpenParksAt?: DatabaseReplayExecutor["signalOpenParksAt"];
  } = {}
) {
  const {
    store = createRecordingWorkflowStore(),
    storeForPass = (passStore) => passStore,
    entities,
    guarded = false,
    signalOpenParksAt,
  } = options;
  const input = {
    graph,
    executionId: "exec_parallel",
    workflowId: "workflow_parallel",
    startEventName: START_EVENT,
    startPayload: { appointment: { id: "123" } },
    ...(guarded
      ? { entityType: "appointment", entityId: "appointment_123" }
      : {}),
  };

  return driveWithReplay(
    (runtime, pass) =>
      executeWorkflow(
        input,
        runtime,
        storeForPass(store, pass),
        actions,
        entities
      ),
    { executor: { kind: "database", signalOpenParksAt } }
  );
}

/**
 * Two sibling delay Waits on the Started outlet, each with a node behind it.
 * With `canceledOutlet` the entry node declares a Cancel Event and one node
 * hangs off its Canceled outlet.
 */
function siblingWaitsGraph(
  shortWait: string,
  longWait: string,
  options: { canceledOutlet?: boolean } = {}
) {
  const canceled = options.canceledOutlet === true;
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode("entry", canceled ? CANCELABLE : {}),
      waitNode("short_wait", shortWait),
      sendNode("after_short"),
      waitNode("long_wait", longWait),
      sendNode("after_long"),
      ...(canceled ? [sendNode("canceled_sms")] : []),
    ],
    edges: [
      ...(canceled
        ? [
            {
              id: "e5",
              source: "entry",
              sourceHandle: "canceled",
              target: "canceled_sms",
            },
          ]
        : []),
      {
        id: "e1",
        source: "entry",
        sourceHandle: "started",
        target: "short_wait",
      },
      {
        id: "e2",
        source: "short_wait",
        sourceHandle: null,
        target: "after_short",
      },
      {
        id: "e3",
        source: "entry",
        sourceHandle: "started",
        target: "long_wait",
      },
      {
        id: "e4",
        source: "long_wait",
        sourceHandle: null,
        target: "after_long",
      },
    ],
  });
}

/** A node beside two delay Waits in a row on the Started outlet. */
function waitBehindWaitGraph() {
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode("entry"),
      sendNode("notify"),
      waitNode("first_wait", "30s"),
      waitNode("second_wait", "30s"),
      sendNode("follow_up"),
    ],
    edges: [
      {
        id: "e1",
        source: "entry",
        sourceHandle: "started",
        target: "notify",
      },
      {
        id: "e2",
        source: "entry",
        sourceHandle: "started",
        target: "first_wait",
      },
      {
        id: "e3",
        source: "first_wait",
        sourceHandle: null,
        target: "second_wait",
      },
      {
        id: "e4",
        source: "second_wait",
        sourceHandle: null,
        target: "follow_up",
      },
    ],
  });
}

/**
 * `above`, then a delay Wait, then an `echo` node whose `subject` is the
 * template `subject`, which addresses `above`.
 */
function templateBehindWaitGraph(above: WorkflowNode, subject: string) {
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode("entry"),
      above,
      waitNode("wait_before", "30s"),
      actionNode("follow_up", { actionType: ECHO_ACTION_ID, subject }),
    ],
    edges: [
      {
        id: "e1",
        source: "entry",
        sourceHandle: "started",
        target: above.id,
      },
      {
        id: "e2",
        source: above.id,
        sourceHandle: null,
        target: "wait_before",
      },
      {
        id: "e3",
        source: "wait_before",
        sourceHandle: null,
        target: "follow_up",
      },
    ],
  });
}

/** A ten-minute Wait on the Started outlet, and one node on the Canceled one. */
function cancelableWaitGraph() {
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode("entry", CANCELABLE),
      waitNode("wait_before", "10m"),
      sendNode("reminder"),
      sendNode("canceled_sms"),
    ],
    edges: [
      {
        id: "e1",
        source: "entry",
        sourceHandle: "started",
        target: "wait_before",
      },
      {
        id: "e2",
        source: "wait_before",
        sourceHandle: null,
        target: "reminder",
      },
      {
        id: "e3",
        source: "entry",
        sourceHandle: "canceled",
        target: "canceled_sms",
      },
    ],
  });
}

/** A node that fails behind a Wait, beside a branch that succeeds. */
function failureBehindWaitGraph() {
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode("entry"),
      waitNode("wait_before", "30s"),
      // No action type, which is a node that fails without running.
      actionNode("broken", {}),
      sendNode("elsewhere"),
    ],
    edges: [
      {
        id: "e1",
        source: "entry",
        sourceHandle: "started",
        target: "wait_before",
      },
      {
        id: "e2",
        source: "wait_before",
        sourceHandle: null,
        target: "broken",
      },
      {
        id: "e3",
        source: "entry",
        sourceHandle: "started",
        target: "elsewhere",
      },
    ],
  });
}

/** A Cancel claim on the recording store's execution row. */
function landCancelClaim(store: RecordingWorkflowStore) {
  store.terminationState = {
    status: "running",
    claim: {
      kind: "cancel",
      requestedAt: "2026-10-19T15:00:00.000Z",
      eventName: "app/appointment.canceled",
      payload: {},
    },
    didWrite: false,
  };
}

describe("a wait node beside another branch", () => {
  it("lets the branch that suspends nothing finish before the run parks", async () => {
    const run = await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          actionNode("split", {
            actionType: BUILT_IN_ACTION_IDS.eventSplit,
          }),
          sendNode("scheduled_sms"),
          waitNode("wait_before", "30s"),
          sendNode("reminder"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "split",
          },
          {
            id: "e2",
            source: "split",
            sourceHandle: eventSplitOutlet(START_EVENT),
            target: "scheduled_sms",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "started",
            target: "wait_before",
          },
          {
            id: "e4",
            source: "wait_before",
            sourceHandle: null,
            target: "reminder",
          },
        ],
      })
    );

    expect(run.value).toMatchObject({ kind: "ended", success: true });
    expect(dispatchClock(run.executed, "scheduled_sms")).toBe(0);
    expect(dispatchClock(run.executed, "reminder")).toBeGreaterThan(25_000);
  });

  it("lets the branch that suspends nothing finish in the pass that parks, in one run", async () => {
    const run = await runGraphInOneRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          actionNode("split", {
            actionType: BUILT_IN_ACTION_IDS.eventSplit,
          }),
          sendNode("scheduled_sms"),
          waitNode("wait_before", "30s"),
          sendNode("reminder"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "split",
          },
          {
            id: "e2",
            source: "split",
            sourceHandle: eventSplitOutlet(START_EVENT),
            target: "scheduled_sms",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "started",
            target: "wait_before",
          },
          {
            id: "e4",
            source: "wait_before",
            sourceHandle: null,
            target: "reminder",
          },
        ],
      })
    );

    expect(run.value).toMatchObject({ kind: "ended", success: true });
    expect(dispatchClock(run.executed, "scheduled_sms")).toBe(0);
    expect(dispatchClock(run.executed, "reminder")).toBeGreaterThan(25_000);
    expect(run.runs).toBe(1);
  });

  it("runs a short branch at its own target while a long sibling is still parked", async () => {
    const run = await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          waitNode("short_wait", "30s"),
          sendNode("after_short"),
          waitNode("long_wait", "10m"),
          sendNode("after_long"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "short_wait",
          },
          {
            id: "e2",
            source: "short_wait",
            sourceHandle: null,
            target: "after_short",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "started",
            target: "long_wait",
          },
          {
            id: "e4",
            source: "long_wait",
            sourceHandle: null,
            target: "after_long",
          },
        ],
      })
    );

    // Both timers run at once, so the run costs the longer of the two rather
    // than their sum.
    expect(run.elapsedMs).toBeLessThan(11 * 60 * 1000);
    expect(dispatchClock(run.executed, "after_long")).toBeGreaterThan(
      9 * 60 * 1000
    );

    // The defect this design exists to remove. A run wakes once, at the last of
    // its outstanding pauses, so both waits on one run put the 30-second branch
    // nine and a half minutes late. Each waiting branch holds its own run, so
    // the short one lands on its own target.
    expect(dispatchClock(run.executed, "after_short")).toBeLessThan(60_000);
    // The root, and one run per waiting branch.
    expect(run.runs).toBe(3);
  });

  // The run wakes when any one park resolves, so both Waits park in one run
  // and the short branch still lands on its own target.
  it("runs a short branch at its own target while a long sibling is still parked, in one run", async () => {
    const run = await runGraphInOneRun(siblingWaitsGraph("30s", "10m"));

    expect(run.elapsedMs).toBeLessThan(11 * 60 * 1000);
    expect(dispatchClock(run.executed, "after_long")).toBeGreaterThan(
      9 * 60 * 1000
    );
    expect(dispatchClock(run.executed, "after_short")).toBeLessThan(60_000);
    expect(run.runs).toBe(1);
  });

  // The timings ADR-0011 measured with a run per branch. The delay derives its
  // remaining time from Date.now(), so each park can land a millisecond early.
  it("acts on sibling Waits of 20 and 90 seconds at their own targets, in one run", async () => {
    const run = await runGraphInOneRun(siblingWaitsGraph("20s", "90s"));

    expect(run.value.status).toBe("completed");
    expect(dispatchClock(run.executed, "after_short")).toBeGreaterThan(19_000);
    expect(dispatchClock(run.executed, "after_short")).toBeLessThanOrEqual(
      20_000
    );
    expect(dispatchClock(run.executed, "after_long")).toBeGreaterThan(89_000);
    expect(dispatchClock(run.executed, "after_long")).toBeLessThanOrEqual(
      90_000
    );
    // One pass parks both, one runs the short branch, one the long.
    expect(run.invocations).toBe(3);
    expect(run.runs).toBe(1);
  });

  // The branch run that wins an Exit claim wakes the sibling branch run parked
  // on its Wait. The sibling halts at that Wait, and the run ends `exited` at
  // the Exit rather than at the sibling Wait's ten-minute target.
  it("returns a child Exit to the parent and wakes a sibling parked on a Wait", async () => {
    const store = createRecordingWorkflowStore();
    const checkedNodes: string[] = [];
    const entities: WorkflowEntities = {
      resolveNode: (input) =>
        Effect.sync(() => {
          checkedNodes.push(input.nodeId);
          const decision =
            input.nodeId === "after_short"
              ? {
                  outcome: "exit" as const,
                  reason: "entity_condition_not_met" as const,
                  checkedAt: "2026-10-19T15:00:00.000Z",
                }
              : { outcome: "eligible" as const };
          return { decision, values: {} };
        }),
    };

    const run = await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry", GUARDED),
          waitNode("short_wait", "30s"),
          sendNode("after_short"),
          waitNode("long_wait", "10m"),
          sendNode("after_long"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "short_wait",
          },
          {
            id: "e2",
            source: "short_wait",
            sourceHandle: null,
            target: "after_short",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "started",
            target: "long_wait",
          },
          {
            id: "e4",
            source: "long_wait",
            sourceHandle: null,
            target: "after_long",
          },
        ],
      }),
      { store, entities, guarded: true }
    );

    expect(run.value).toMatchObject({
      status: "exited",
      success: true,
      exit: {
        reason: "entity_condition_not_met",
        nodeId: "after_short",
      },
    });
    // The run ends at the short Wait's 30 seconds, when the Exit was claimed,
    // long before the sibling's 10-minute Wait. The delay derives its remaining
    // time from Date.now(), so the replay clock can land a millisecond early.
    expect(run.elapsedMs).toBeGreaterThan(29_000);
    expect(run.elapsedMs).toBeLessThanOrEqual(30_000);
    expect(checkedNodes).toContain("short_wait");
    expect(checkedNodes).toContain("long_wait");
    expect(checkedNodes).toContain("after_short");
    expect(checkedNodes).not.toContain("after_long");
    expect(dispatchClock(run.executed, "after_long")).toBeUndefined();
    // The sibling's timeline names the Exit that woke it, and its row closed.
    expect(
      store
        .callsOf("recordAuditEvent")
        .filter((event) => event.eventType === "run_resumed")
        .map((event) => event.message)
    ).toContain("Run woken by an Exit in node 'long_wait'");
    expect(
      store
        .callsOf("markWaitStateStatus")
        .filter((call) => call.status === "cancelled")
    ).toHaveLength(1);
    // Each branch run closed its own rows before it returned, so the kill
    // sweep has nothing to close and never runs.
    expect(store.callsOf("cancelOpenWork")).toHaveLength(0);
    expect(store.callsOf("completeRun")[0]?.status).toBe("exited");
  });

  // The store write that wins the Exit claim resolves every park still open
  // with an Exit wake, inside the pass that claimed it. The run goes again at
  // once, the sibling Wait halts on that wake, and the run ends `exited` at the
  // short Wait's 30 seconds.
  it("wakes a sibling parked on a Wait with the Exit its branch claimed, in one run", async () => {
    const store = createRecordingWorkflowStore();
    const checkedNodes: string[] = [];
    const entities: WorkflowEntities = {
      resolveNode: (input) =>
        Effect.sync(() => {
          checkedNodes.push(input.nodeId);
          const decision =
            input.nodeId === "after_short"
              ? {
                  outcome: "exit" as const,
                  reason: "entity_condition_not_met" as const,
                  checkedAt: "2026-10-19T15:00:00.000Z",
                }
              : { outcome: "eligible" as const };
          return { decision, values: {} };
        }),
    };
    const exitWakesOpenParks = (
      passStore: WorkflowStore,
      pass: ReplayPass
    ): WorkflowStore => ({
      ...passStore,
      requestExit: (input) =>
        Effect.tap(passStore.requestExit(input), (claimed) =>
          claimed?.didWrite && claimed.claim?.kind === "exit"
            ? Effect.promise(
                async () => await pass.signalOpenParks?.(EXIT_WAKE)
              )
            : Effect.void
        ),
    });

    const run = await runGraphInOneRun(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry", GUARDED),
          waitNode("short_wait", "30s"),
          sendNode("after_short"),
          waitNode("long_wait", "10m"),
          sendNode("after_long"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "short_wait",
          },
          {
            id: "e2",
            source: "short_wait",
            sourceHandle: null,
            target: "after_short",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "started",
            target: "long_wait",
          },
          {
            id: "e4",
            source: "long_wait",
            sourceHandle: null,
            target: "after_long",
          },
        ],
      }),
      {
        store,
        storeForPass: exitWakesOpenParks,
        entities,
        guarded: true,
      }
    );

    expect(run.value).toMatchObject({
      status: "exited",
      success: true,
      exit: {
        reason: "entity_condition_not_met",
        nodeId: "after_short",
      },
    });
    expect(run.elapsedMs).toBeGreaterThan(29_000);
    expect(run.elapsedMs).toBeLessThanOrEqual(30_000);
    expect(checkedNodes).toContain("short_wait");
    expect(checkedNodes).toContain("long_wait");
    expect(checkedNodes).toContain("after_short");
    expect(checkedNodes).not.toContain("after_long");
    expect(dispatchClock(run.executed, "after_long")).toBeUndefined();
    expect(
      store
        .callsOf("recordAuditEvent")
        .filter((event) => event.eventType === "run_resumed")
        .map((event) => event.message)
    ).toContain("Run woken by an Exit in node 'long_wait'");
    expect(
      store
        .callsOf("markWaitStateStatus")
        .filter((call) => call.status === "cancelled")
    ).toHaveLength(1);
    expect(store.callsOf("cancelOpenWork")).toHaveLength(0);
    expect(store.callsOf("completeRun").map((call) => call.status)).toEqual([
      "exited",
    ]);
    expect(run.runs).toBe(1);
  });

  // Only a park writes "waiting", and the short branch's resume writes
  // "running". The long sibling is still parked when that branch finishes, so
  // the branch offers the run back to the repository, whose guard decides.
  it("offers the run back to waiting when its branch finishes beside a parked sibling", async () => {
    const store = createRecordingWorkflowStore();
    await runGraph(
      createSerializedWorkflowGraph({
        nodes: [
          lifecycleNode("entry"),
          waitNode("short_wait", "30s"),
          sendNode("after_short"),
          waitNode("long_wait", "10m"),
          sendNode("after_long"),
        ],
        edges: [
          {
            id: "e1",
            source: "entry",
            sourceHandle: "started",
            target: "short_wait",
          },
          {
            id: "e2",
            source: "short_wait",
            sourceHandle: null,
            target: "after_short",
          },
          {
            id: "e3",
            source: "entry",
            sourceHandle: "started",
            target: "long_wait",
          },
          {
            id: "e4",
            source: "long_wait",
            sourceHandle: null,
            target: "after_long",
          },
        ],
      }),
      { store }
    );

    // One offer per branch run, and none from the root, which ends the run with
    // its terminal record instead.
    expect(store.callsOf("markExecutionWaitingIfParked")).toEqual([
      { executionId: "exec_parallel" },
      { executionId: "exec_parallel" },
    ]);
  });

  // Every pass that ends parked offers the run back to waiting: the pass that
  // parks both Waits, and the pass whose short branch resumed and finished
  // while the long sibling stayed parked. The pass that ends the run writes its
  // terminal record instead.
  it("offers the run back to waiting from each pass that ends parked, in one run", async () => {
    const store = createRecordingWorkflowStore();
    const run = await runGraphInOneRun(siblingWaitsGraph("30s", "10m"), {
      store,
    });

    expect(run.invocations).toBe(3);
    expect(store.callsOf("markExecutionWaitingIfParked")).toEqual([
      { executionId: "exec_parallel" },
      { executionId: "exec_parallel" },
    ]);
  });

  it("takes a second wait further down the same branch on a later pass", async () => {
    const run = await runGraph(waitBehindWaitGraph());

    expect(run.value).toMatchObject({ kind: "ended", success: true });
    expect(dispatchClock(run.executed, "notify")).toBe(0);
    // Two waits in a row, so the branch behind them costs both.
    expect(dispatchClock(run.executed, "follow_up")).toBeGreaterThan(55_000);
  });

  it("takes a second wait further down the same branch on a later pass, in one run", async () => {
    const run = await runGraphInOneRun(waitBehindWaitGraph());

    expect(run.value).toMatchObject({ kind: "ended", success: true });
    expect(dispatchClock(run.executed, "notify")).toBe(0);
    expect(dispatchClock(run.executed, "follow_up")).toBeGreaterThan(55_000);
    // One pass parks the first Wait, one parks the second, one finishes.
    expect(run.invocations).toBe(3);
    expect(run.runs).toBe(1);
  });

  it("resolves a template behind the wait against a node above it", async () => {
    echoedConfig = undefined;

    const run = await runGraph(
      templateBehindWaitGraph(sendNode("notify"), "{{@notify:Notify.sent}}")
    );

    expect(run.value).toMatchObject({ kind: "ended", success: true });
    // The branch run walked none of the graph above its entry node, so this
    // value came back out of the store rather than out of a traversal.
    expect(echoedConfig).toMatchObject({ subject: "true" });
  });

  // The pass that runs the node behind the Wait replays the node above it from
  // the memo, so the template reads the output that pass's traversal rebuilt.
  it("resolves a template behind the wait against a node above it, in one run", async () => {
    echoedConfig = undefined;

    const run = await runGraphInOneRun(
      templateBehindWaitGraph(sendNode("notify"), "{{@notify:Notify.sent}}")
    );

    expect(run.value).toMatchObject({ kind: "ended", success: true });
    expect(echoedConfig).toMatchObject({ subject: "true" });
  });

  /**
   * A node's stored row holds the step's payload while a traversal holds the
   * envelope around it, and every reader steps through one envelope. A payload
   * that is itself `{ success, data }` is where that difference shows: read back
   * bare, it would be stepped through twice and the template would resolve
   * against the wrong object.
   */
  it("reads an inherited output the way the run above it would have", async () => {
    echoedConfig = undefined;

    await runGraph(
      templateBehindWaitGraph(
        actionNode("wrapped", { actionType: WRAP_ACTION_ID }),
        "{{@wrapped:Wrap.id}}"
      )
    );

    expect(echoedConfig).toMatchObject({ subject: "inner" });
  });

  // One run inherits nothing, so the output is the one the pass's traversal
  // rebuilt from the memo. A step-envelope-shaped payload must still be stepped
  // through once after it round-tripped through that memo.
  it("reads an output above the wait the way the pass that produced it did, in one run", async () => {
    echoedConfig = undefined;

    await runGraphInOneRun(
      templateBehindWaitGraph(
        actionNode("wrapped", { actionType: WRAP_ACTION_ID }),
        "{{@wrapped:Wrap.id}}"
      )
    );

    expect(echoedConfig).toMatchObject({ subject: "inner" });
  });

  /**
   * The rows a killed branch leaves behind. It was stopped where it stood, so
   * nothing inside it can close its own row, and the run that started it is
   * the only thing alive that knows the Execution.
   */
  it("closes what a killed branch left open before taking the Canceled outlet", async () => {
    const store = createRecordingWorkflowStore();
    let reads = 0;
    const cancelStore: WorkflowStore = {
      ...store,
      // The entry node reads first and finds nothing, which is what lets the
      // wait be handed off at all. The cancel lands while the branch is parked,
      // and the node that handed it off is the next to ask.
      readPendingCancel: (executionId: string) =>
        Effect.gen(function* () {
          yield* store.readPendingCancel(executionId);
          reads += 1;
          return reads === 1
            ? null
            : ({
                eventName: "app/appointment.canceled",
                payload: {},
              } satisfies PendingCancel);
        }),
    };

    const run = await runGraph(cancelableWaitGraph(), {
      store: cancelStore,
      killBranchesAtMs: 30_000,
    });

    // The branch died mid-sleep, so the node behind it never ran.
    expect(dispatchClock(run.executed, "reminder")).toBeUndefined();
    expect(store.callsOf("cancelOpenWork")).toHaveLength(1);

    // Order is the whole of what makes the sweep safe: after the kill was
    // observed, before the Canceled branch opened a row of its own.
    const sweptAt = store.calls.findIndex(
      (call) => call.method === "cancelOpenWork"
    );
    const canceledBranchAt = store.calls.findIndex(
      (call) =>
        call.method === "startStepLog" && call.input.nodeId === "canceled_sms"
    );
    expect(sweptAt).toBeGreaterThanOrEqual(0);
    expect(sweptAt).toBeLessThan(canceledBranchAt);
    expect(store.callsOf("completeRun")[0]?.status).toBe("canceled");
  });

  // In one run nothing is killed. The Cancel Event writes its claim and
  // resolves the parked Wait with a cancel wake, so the Wait closes its own
  // rows in the next pass before the Canceled outlet opens one, and no sweep
  // is needed.
  it("closes a parked Wait's rows on the cancel wake before taking the Canceled outlet, in one run", async () => {
    const store = createRecordingWorkflowStore();

    const run = await runGraphInOneRun(cancelableWaitGraph(), {
      store,
      signalOpenParksAt: {
        atMs: 30_000,
        wake: CANCEL_WAKE,
        write: () => landCancelClaim(store),
      },
    });

    expect(dispatchClock(run.executed, "reminder")).toBeUndefined();
    expect(dispatchClock(run.executed, "canceled_sms")).toBe(30_000);
    expect(store.callsOf("cancelOpenWork")).toHaveLength(0);

    const closedAt = store.calls.findIndex(
      (call) =>
        call.method === "markWaitStateStatus" &&
        call.input.status === "cancelled"
    );
    const canceledBranchAt = store.calls.findIndex(
      (call) =>
        call.method === "startStepLog" && call.input.nodeId === "canceled_sms"
    );
    expect(closedAt).toBeGreaterThanOrEqual(0);
    expect(closedAt).toBeLessThan(canceledBranchAt);
    expect(store.callsOf("completeRun").map((call) => call.status)).toEqual([
      "canceled",
    ]);
    expect(run.runs).toBe(1);
  });

  // A Cancel Event while both sibling Waits are parked resolves both parks in
  // one write. The pass that follows halts both Started branches and runs the
  // Canceled outlet once.
  it("runs the Canceled outlet once for a Cancel Event that lands while two Waits are parked, in one run", async () => {
    const store = createRecordingWorkflowStore();

    const run = await runGraphInOneRun(
      siblingWaitsGraph("20s", "90s", { canceledOutlet: true }),
      {
        store,
        signalOpenParksAt: {
          atMs: 10_000,
          wake: CANCEL_WAKE,
          write: () => landCancelClaim(store),
        },
      }
    );

    expect(run.value.status).toBe("canceled");
    expect(run.elapsedMs).toBe(10_000);
    expect(dispatchClock(run.executed, "after_short")).toBeUndefined();
    expect(dispatchClock(run.executed, "after_long")).toBeUndefined();
    expect(
      store
        .callsOf("startStepLog")
        .filter((open) => open.nodeId === "canceled_sms")
    ).toHaveLength(1);
    expect(
      store
        .callsOf("markWaitStateStatus")
        .map((call) => call.status)
        .toSorted()
    ).toEqual(["cancelled", "cancelled"]);
    expect(store.callsOf("completeRun").map((call) => call.status)).toEqual([
      "canceled",
    ]);
    // One pass parks both Waits, and the pass after the Cancel Event ends it.
    expect(run.invocations).toBe(2);
    expect(run.runs).toBe(1);
  });

  it("carries a failure inside a branch back as that node's own", async () => {
    const run = await runGraph(failureBehindWaitGraph());

    // The run answers for what its branch did, and for that node alone: the
    // branch beside it succeeded and the Wait it hung off did too.
    expect(run.value).toMatchObject({ kind: "ended", success: false });
    expect(run.value.results.broken?.success).toBe(false);
    expect(run.value.results.wait_before?.success).toBe(true);
    expect(run.value.results.elsewhere?.success).toBe(true);
  });

  it("answers for a failure behind a Wait as that node's own, in one run", async () => {
    const run = await runGraphInOneRun(failureBehindWaitGraph());

    expect(run.value).toMatchObject({ kind: "ended", success: false });
    expect(run.value.results.broken?.success).toBe(false);
    expect(run.value.results.wait_before?.success).toBe(true);
    expect(run.value.results.elsewhere?.success).toBe(true);
    expect(run.runs).toBe(1);
  });

  /**
   * A wait held back is the one thing a run carries across the Canceled outlet.
   * Every other node on the Started branch stops there by never being scheduled,
   * so this is the case the queue has to answer for itself.
   */
  it("drops a held-back wait once the run has taken the Canceled outlet", async () => {
    const store = createRecordingWorkflowStore();
    let reads = 0;
    const cancelStore = {
      ...store,
      // The entry node reads first and finds nothing, which is what lets the
      // Started branch fan out and park its wait in the queue. The cancel lands
      // at the node after it.
      readPendingCancel: (executionId: string) =>
        Effect.gen(function* () {
          yield* store.readPendingCancel(executionId);
          reads += 1;
          return reads === 1
            ? null
            : ({
                eventName: "app/appointment.canceled",
                payload: {},
              } satisfies PendingCancel);
        }),
    };

    const result = await executeWorkflow(
      {
        graph: createSerializedWorkflowGraph({
          nodes: [
            lifecycleNode("entry", CANCELABLE),
            sendNode("scheduled_sms"),
            waitNode("wait_before", "30s"),
            sendNode("reminder"),
            sendNode("canceled_sms"),
          ],
          edges: [
            {
              id: "e1",
              source: "entry",
              sourceHandle: "started",
              target: "scheduled_sms",
            },
            {
              id: "e2",
              source: "entry",
              sourceHandle: "started",
              target: "wait_before",
            },
            {
              id: "e3",
              source: "wait_before",
              sourceHandle: null,
              target: "reminder",
            },
            {
              id: "e4",
              source: "entry",
              sourceHandle: "canceled",
              target: "canceled_sms",
            },
          ],
        }),
        executionId: "exec_cancel",
        workflowId: "workflow_cancel",
        startEventName: START_EVENT,
      },
      createInMemoryWorkflowRuntime(),
      cancelStore,
      actions
    );

    expect(result).toMatchObject({ kind: "ended", success: true });
    // No wait state, so the run never parked on a branch it had left.
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(store.callsOf("startStepLog").map((open) => open.nodeId)).toEqual([
      "entry",
      "scheduled_sms",
      "canceled_sms",
    ]);
  });
});
