/**
 * The graphs the parallel-Wait suite drives, and its cases: what a Wait node
 * costs the branches beside it. Every Wait parks in the one run, which wakes
 * when any one park resolves.
 */

import { expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { unknownRest } from "@wfgraph/shared/types/schema";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { eventSplitOutlet } from "@wfgraph/shared/lifecycle/event-split";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { WorkflowEntities } from "#src/backend/engine/entities";
import type { WorkflowStore } from "#src/backend/engine/store";
import { assembleExtensions } from "#src/backend/extensions/extension-set";
import { defineAction } from "#src/backend/extensions/define-action";
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
  type ReplayPass,
} from "#src/backend/engine/testing/replay-runtime";
import {
  CANCEL_WAKE,
  EXIT_WAKE,
} from "#src/backend/engine/testing/wait-fixtures";

const SEND_ACTION_ID = "test/send";
const ECHO_ACTION_ID = "test/echo";
const WRAP_ACTION_ID = "test/wrap";
export const START_EVENT = "app/appointment.created";

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

export const actions = createWorkflowActions(
  assembleExtensions({ actions: [sendAction, echoAction, wrapAction] }),
  stubWfGraphRuntime()
);

export function lifecycleNode(
  id: string,
  config: JsonObject = {}
): WorkflowNode {
  return {
    id,
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Appointments", type: "lifecycle", config },
  };
}

/** Only a graph declaring a Cancel Event ever buys the boundary read. */
export const CANCELABLE: JsonObject = {
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

export function sendNode(id: string): WorkflowNode {
  return actionNode(id, { actionType: SEND_ACTION_ID });
}

export function waitNode(id: string, waitDuration: string): WorkflowNode {
  return actionNode(id, {
    actionType: BUILT_IN_ACTION_IDS.wait,
    waitMode: "delay",
    waitDuration,
    waitGateMode: "require_actual_wait",
  });
}

/** The clock at which a node's own step ran, or undefined if it never did. */
export function dispatchClock(
  executed: ReadonlyArray<{ stepId: string; at: number }>,
  nodeId: string
): number | undefined {
  return executed.find((step) => step.stepId === `node:${nodeId}:dispatch`)?.at;
}

/**
 * Drives one graph the way a live run goes under `executor`: one run per
 * Execution, which enters every Wait where it stands and runs the body again
 * from the top whenever one of its parks resolves.
 *
 * `storeForPass` wraps the store a pass writes through, for a case whose store
 * write is also a producer that resolves parks during the pass.
 */
export function runGraph(
  graph: ReturnType<typeof createSerializedWorkflowGraph>,
  executor: ReplayExecutor,
  options: {
    store?: RecordingWorkflowStore;
    storeForPass?: (store: WorkflowStore, pass: ReplayPass) => WorkflowStore;
    entities?: WorkflowEntities;
    guarded?: boolean;
  } = {}
) {
  const {
    store = createRecordingWorkflowStore(),
    storeForPass = (passStore) => passStore,
    entities,
    guarded = false,
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
    { executor, waitRows: store }
  );
}

/** An Event Split and a thirty-second Wait, side by side on the Started outlet. */
function splitBesideWaitGraph() {
  return createSerializedWorkflowGraph({
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
  });
}

/**
 * Two sibling delay Waits on the Started outlet, each with a node behind it.
 * With `canceledOutlet` the entry node declares a Cancel Event and one node
 * hangs off its Canceled outlet. With `guarded` the entry node tracks an
 * Entity and checks its Eligibility before each node.
 */
function siblingWaitsGraph(
  shortWait: string,
  longWait: string,
  options: { canceledOutlet?: boolean; guarded?: boolean } = {}
) {
  const canceled = options.canceledOutlet === true;
  const entryConfig = options.guarded === true ? GUARDED : {};
  return createSerializedWorkflowGraph({
    nodes: [
      lifecycleNode("entry", canceled ? CANCELABLE : entryConfig),
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
export function cancelableWaitGraph() {
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

/**
 * Entity checks that admit every node but `after_short`, which claims an Exit,
 * and the node ids in the order they were checked.
 */
function exitAtAfterShort() {
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
  return { checkedNodes, entities };
}

/**
 * The store write that wins an Exit claim, which also resolves every park
 * still open with an Exit wake inside the pass that claimed it.
 */
function exitWakesOpenParks(
  passStore: WorkflowStore,
  pass: ReplayPass
): WorkflowStore {
  return {
    ...passStore,
    requestExit: (input) =>
      Effect.tap(passStore.requestExit(input), (claimed) =>
        claimed?.didWrite && claimed.claim?.kind === "exit"
          ? Effect.promise(async () => await pass.resolveOpenParks(EXIT_WAKE))
          : Effect.void
      ),
  };
}

export function defineParallelWaitReplayCases(executor: ReplayExecutor): void {
  it("lets the branch that suspends nothing finish before the run parks", async () => {
    const run = await runGraph(splitBesideWaitGraph(), executor);

    expect(run.value).toMatchObject({ kind: "ended", success: true });
    expect(dispatchClock(run.executed, "scheduled_sms")).toBe(0);
    expect(dispatchClock(run.executed, "reminder")).toBeGreaterThan(25_000);
  });

  // The run wakes when any one park resolves, so the short branch lands on its
  // own target while the long sibling stays parked.
  it("runs a short branch at its own target while a long sibling is still parked", async () => {
    const run = await runGraph(siblingWaitsGraph("30s", "10m"), executor);

    // Both timers run at once, so the run costs the longer of the two rather
    // than their sum.
    expect(run.elapsedMs).toBeLessThan(11 * 60 * 1000);
    expect(dispatchClock(run.executed, "after_long")).toBeGreaterThan(
      9 * 60 * 1000
    );
    expect(dispatchClock(run.executed, "after_short")).toBeLessThan(60_000);
  });

  // The Exit claim wakes the sibling parked on its Wait: the store write that
  // wins it resolves every park still open. The sibling halts at its Wait, and
  // the run ends `exited` at the short Wait's 30 seconds rather than at the
  // sibling Wait's ten-minute target.
  it("wakes a sibling parked on a Wait with the Exit its branch claimed", async () => {
    const store = createRecordingWorkflowStore();
    const { checkedNodes, entities } = exitAtAfterShort();

    const run = await runGraph(
      siblingWaitsGraph("30s", "10m", { guarded: true }),
      executor,
      { store, storeForPass: exitWakesOpenParks, entities, guarded: true }
    );

    expect(run.value).toMatchObject({
      status: "exited",
      success: true,
      exit: {
        reason: "entity_condition_not_met",
        nodeId: "after_short",
      },
    });
    // The delay derives its remaining time from Date.now(), so the replay
    // clock can land a millisecond early.
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
    expect(store.callsOf("completeRun").map((call) => call.status)).toEqual([
      "exited",
    ]);
  });

  // Only a park writes "waiting", and the short branch's resume writes
  // "running". The long sibling is still parked when that branch finishes, so
  // the run is offered back to the repository, whose guard decides. Each pass
  // that ends parked makes one offer: the pass that parks both Waits, and the
  // pass whose short branch resumed and finished.
  it("offers the run back to waiting when a branch finishes beside a parked sibling", async () => {
    const store = createRecordingWorkflowStore();
    await runGraph(siblingWaitsGraph("30s", "10m"), executor, { store });

    expect(store.callsOf("markExecutionWaitingIfParked")).toEqual([
      { executionId: "exec_parallel" },
      { executionId: "exec_parallel" },
    ]);
  });

  it("takes a second wait further down the same branch on a later pass", async () => {
    const run = await runGraph(waitBehindWaitGraph(), executor);

    expect(run.value).toMatchObject({ kind: "ended", success: true });
    expect(dispatchClock(run.executed, "notify")).toBe(0);
    // Two waits in a row, so the branch behind them costs both.
    expect(dispatchClock(run.executed, "follow_up")).toBeGreaterThan(55_000);
  });

  // The pass that runs the node behind the Wait replays the node above it from
  // the memo, so the template reads the output that pass's traversal rebuilt.
  it("resolves a template behind the wait against a node above it", async () => {
    echoedConfig = undefined;

    const run = await runGraph(
      templateBehindWaitGraph(sendNode("notify"), "{{@notify:Notify.sent}}"),
      executor
    );

    expect(run.value).toMatchObject({ kind: "ended", success: true });
    expect(echoedConfig).toMatchObject({ subject: "true" });
  });

  /**
   * A node's stored row holds the step's payload while a traversal holds the
   * envelope around it, and every reader steps through one envelope. A payload
   * that is itself `{ success, data }` is where that difference shows: read
   * back bare, it would be stepped through twice and the template would
   * resolve against the wrong object. The run reads the output its traversal
   * rebuilt from the memo, which must still be stepped through once after it
   * round-tripped through that memo.
   */
  it("reads an output above the wait the way the run that produced it did", async () => {
    echoedConfig = undefined;

    await runGraph(
      templateBehindWaitGraph(
        actionNode("wrapped", { actionType: WRAP_ACTION_ID }),
        "{{@wrapped:Wrap.id}}"
      ),
      executor
    );

    expect(echoedConfig).toMatchObject({ subject: "inner" });
  });

  it("answers for a failure behind a Wait as that node's own", async () => {
    const run = await runGraph(failureBehindWaitGraph(), executor);

    // The run answers for what its branch did, and for that node alone: the
    // branch beside it succeeded and the Wait it hung off did too.
    expect(run.value).toMatchObject({ kind: "ended", success: false });
    expect(run.value.results.broken?.success).toBe(false);
    expect(run.value.results.wait_before?.success).toBe(true);
    expect(run.value.results.elsewhere?.success).toBe(true);
  });

  // One pass parks every Wait it reaches, and each pass after it runs what one
  // resolution released. Two siblings take one pass to park both, one for the
  // short branch, and one for the long. Two Waits in a row take one pass to
  // park the first, one to park the second, and one to finish.
  it.each([
    {
      graph: "two sibling Waits",
      build: () => siblingWaitsGraph("30s", "10m"),
    },
    { graph: "two Waits in a row", build: waitBehindWaitGraph },
  ])("takes three passes for $graph", async ({ build }) => {
    const run = await runGraph(build(), executor);

    expect(run.invocations).toBe(3);
  });

  // The delay derives its remaining time from Date.now(), so each park can land
  // a millisecond early.
  it("acts on sibling Waits of 20 and 90 seconds at their own targets", async () => {
    const run = await runGraph(siblingWaitsGraph("20s", "90s"), executor);

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
  });

  // The Cancel Event writes its claim and resolves the parked Wait with a
  // cancel wake, so the Wait closes its own rows in the next pass before the
  // Canceled outlet opens one.
  it("closes a parked Wait's rows on the cancel wake before taking the Canceled outlet", async () => {
    const store = createRecordingWorkflowStore();

    const run = await runGraph(
      cancelableWaitGraph(),
      {
        ...executor,
        resolveOpenParksAt: {
          atMs: 30_000,
          wake: CANCEL_WAKE,
          write: () => landCancelClaim(store),
        },
      },
      { store }
    );

    expect(dispatchClock(run.executed, "reminder")).toBeUndefined();
    expect(dispatchClock(run.executed, "canceled_sms")).toBe(30_000);

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
  });

  // A Cancel Event while both sibling Waits are parked resolves both parks in
  // one write. The pass that follows halts both Started branches and runs the
  // Canceled outlet once.
  it("runs the Canceled outlet once for a Cancel Event that lands while two Waits are parked", async () => {
    const store = createRecordingWorkflowStore();

    const run = await runGraph(
      siblingWaitsGraph("20s", "90s", { canceledOutlet: true }),
      {
        ...executor,
        resolveOpenParksAt: {
          atMs: 10_000,
          wake: CANCEL_WAKE,
          write: () => landCancelClaim(store),
        },
      },
      { store }
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
  });
}
