/**
 * Coverage for the Wait node, driven through the engine so the wait's
 * interaction with both ports is exercised: the durable runtime it suspends on
 * and the store it records its wait state in.
 *
 * The Wait node is the one node the engine never wraps in a step - Inngest
 * forbids a sleep or an event wait inside a step - so it memoizes its own
 * persistence segments around those boundaries. That is what these tests pin.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import { resolveOutputPath } from "@wfgraph/shared/graph/node-references";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { executeTestWorkflow as executeWorkflow } from "#src/backend/engine/test-execution";
import {
  type ExecutionResult,
  executionData,
  executionError,
} from "#src/backend/engine/contracts";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import { noWorkflowActions } from "#src/backend/engine/actions";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";

/**
 * The Wait node's own run-log rows.
 *
 * Every node's rows go through the store, the entry node's included, so a wait's
 * rows are the ones opened against the wait node.
 */
function waitStepLogs(store: RecordingWorkflowStore) {
  const opened = store
    .callsOf("startStepLog")
    .filter((call) => call.nodeType === "Wait");
  const waitLogIds = new Set(
    store
      .callsOf("startStepLog")
      .map((call, index) => ({ call, logId: `log_${index + 1}` }))
      .filter(({ call }) => call.nodeType === "Wait")
      .map(({ logId }) => logId)
  );

  return {
    opened,
    closed: store
      .callsOf("completeStepLog")
      .filter((call) => waitLogIds.has(call.logId)),
  };
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

function createWaitNode(
  id: string,
  config: Record<string, unknown>
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "Wait",
      type: "action",
      config: { actionType: "Wait", ...config },
    },
  };
}

// A node below the wait, so whether the wait halted its branch is a fact about
// what ran rather than a flag on the wait's own result.
function createAfterWaitNode(): WorkflowNode {
  return {
    id: "after_wait",
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: "After Wait",
      type: "action",
      config: { actionType: "Condition", condition: true },
    },
  };
}

function createWaitGraph(config: Record<string, unknown>) {
  return createSerializedWorkflowGraph({
    nodes: [
      createLifecycleNode("lifecycle_1"),
      createWaitNode("wait_1", config),
      createAfterWaitNode(),
    ],
    edges: [
      {
        id: "edge_1",
        source: "lifecycle_1",
        sourceHandle: "started",
        target: "wait_1",
      },
      { id: "edge_2", source: "wait_1", target: "after_wait" },
    ],
  });
}

type RunWaitOptions = {
  config: Record<string, unknown>;
  store: RecordingWorkflowStore;
  resumeEvent?: unknown;
  startPayload?: JsonObject | undefined;
  memo?: Map<string, unknown> | undefined;
};

/**
 * A match comparing one payload field against a value, as the editor stores it:
 * the serialized `ConditionModel` the Condition node builds.
 */
function matchOn(field: string, value: string): string {
  return JSON.stringify({
    version: 2,
    groupLogic: "and",
    groups: [
      {
        id: "group",
        logic: "and",
        conditions: [
          { id: "rule", field, fieldType: "string", operator: "equals", value },
        ],
      },
    ],
  });
}

/**
 * A resume as `resume-waits.ts` sends it: an Inngest event whose `data` is the
 * `workflow/wait.signal` envelope, with the arriving Event's payload inside it.
 * The nesting is what the node's output has to strip.
 */
function waitResumeSignal(
  payload: JsonObject,
  eventType = "billing/payment.settled"
) {
  return {
    name: "workflow/wait.signal",
    id: "evt_signal",
    ts: 0,
    data: {
      executionId: "exec_wait",
      nodeId: "wait_1",
      token: "token_1",
      eventType,
      signalType: "wait-resume",
      payload,
    },
  };
}

/**
 * The Wait node returns an ExecutionResult, which the engine then stores whole
 * as the node's data - so the wait's own output sits one level in.
 */
function waitOutput(result: { results: Record<string, ExecutionResult> }) {
  const nodeData = executionData(result.results.wait_1) as { data?: unknown };
  return nodeData?.data as Record<string, unknown>;
}

/**
 * Whether the wait node halted its branch, read the way a builder would see it:
 * the node below the wait never ran.
 */
function waitHaltedBranch(result: {
  results: Record<string, ExecutionResult>;
}): boolean {
  return result.results.after_wait === undefined;
}

function runWait(options: RunWaitOptions) {
  const runtime = createInMemoryWorkflowRuntime({
    resumeEvent: options.resumeEvent ?? null,
    memo: options.memo,
  });

  const execution = executeWorkflow(
    {
      graph: createWaitGraph(options.config),
      executionId: "exec_wait",
      workflowId: "workflow_wait",
      startPayload: options.startPayload,
    },
    runtime,
    options.store,
    noWorkflowActions
  );

  return { runtime, execution };
}

describe("wait node - delay mode", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("parks the run, sleeps, then resumes and closes its own step log", async () => {
    const { runtime, execution } = runWait({
      config: { waitMode: "delay", waitDuration: "1h" },
      store,
    });
    const result = await execution;

    expect(result.success).toBe(true);
    const waitData = waitOutput(result);
    expect(waitData.waitType).toBe("delay");
    // Timestamps cross a step boundary, so they travel as ISO strings.
    expect(Date.parse(waitData.waitUntil as string)).toBeGreaterThan(
      Date.now()
    );

    const created = store.callsOf("createWaitState");
    expect(created).toHaveLength(1);
    expect(created[0]?.waitType).toBe("delay");
    expect(created[0]?.nodeId).toBe("wait_1");
    expect(created[0]?.executionId).toBe("exec_wait");

    // The park is a signal wait whose timeout is what is left of the delay:
    // roughly an hour, allowing for the milliseconds the run itself took.
    const park = runtime.waits.find(
      (wait) => wait.stepId === "wait-delay-wait_1-0"
    );
    expect(park?.options.timeoutMs).toBeGreaterThan(3_500_000);
    // A delay wait answers to a Migration and to nothing else.
    expect(park?.options.ifExpression).toContain(
      'async.data.signalType == "version-migrate"'
    );
    expect(park?.options.ifExpression).not.toContain("wait-resume");

    // One park, so the row is written once and never re-parked.
    expect(store.callsOf("reparkWaitState")).toHaveLength(0);
    expect(waitData.hops).toBe(1);
    expect(store.callsOf("markWaitStateStatus")).toEqual([
      { waitStateId: "wait_state_1", status: "resumed" },
    ]);
    expect(store.callsOf("markExecutionRunning")).toEqual([
      { executionId: "exec_wait" },
    ]);

    const auditTypes = store
      .callsOf("recordAuditEvent")
      .map((c) => c.eventType);
    expect(auditTypes).toEqual(["run_waiting", "run_resumed", "run_completed"]);

    const stepLogs = waitStepLogs(store);
    expect(stepLogs.opened).toHaveLength(1);
    expect(stepLogs.closed).toEqual([
      expect.objectContaining({ status: "success" }),
    ]);
  });

  it("halts the branch instead of waiting when a gated target has already passed", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "delay",
        waitDuration: "-1h",
        waitGateMode: "require_actual_wait",
      },
      store,
    });
    const result = await execution;

    expect(waitHaltedBranch(result)).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      skipped: true,
      skippedReason: "past_due_no_wait",
    });
    // Nothing to wait for means no wait-state row and no park at all.
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(runtime.waits).toHaveLength(0);
    expect(store.callsOf("recordAuditEvent")[0]?.eventType).toBe("run_skipped");
  });

  it("fails the node when no target timestamp can be resolved", async () => {
    const { execution } = runWait({
      config: { waitMode: "delay", waitDuration: "not a duration" },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(waitStepLogs(store).closed[0]).toMatchObject({ status: "error" });
  });

  it("reuses the memoized wait state and step log across a replay", async () => {
    const memo = new Map<string, unknown>();
    const config = { waitMode: "delay", waitDuration: "1h" };

    await runWait({ config, store, memo }).execution;
    await runWait({ config, store, memo }).execution;

    expect(store.callsOf("createWaitState")).toHaveLength(1);
    expect(waitStepLogs(store).opened).toHaveLength(1);
    expect(store.callsOf("completeRun")).toHaveLength(1);
  });
});

describe("wait node - event mode", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("waits on the signal event scoped to this run, node, and token", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: waitResumeSignal({ approved: true }),
    });
    const result = await execution;

    expect(result.success).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      waitType: "event",
      timedOut: false,
      event: "billing/payment.settled",
      payload: { approved: true },
    });
    // An ordinary resume carries the run on, which is what makes the halting
    // assertions elsewhere in this file mean something.
    expect(waitHaltedBranch(result)).toBe(false);
    expect(result.results.after_wait?.success).toBe(true);

    const resumeToken = store.callsOf("createWaitState")[0]?.resumeToken;
    expect(typeof resumeToken).toBe("string");
    expect(resumeToken).not.toBe("");

    const wait = runtime.waits.at(0);
    expect(wait?.stepId).toBe("wait-event-wait_1-0");
    expect(wait?.options.event).toBe("workflow/wait.signal");
    expect(wait?.options.ifExpression).toContain(`"${resumeToken}"`);
    expect(wait?.options.ifExpression).toContain(
      'async.data.nodeId == "wait_1"'
    );
    expect(wait?.options.timeoutMs).toBeGreaterThan(0);

    expect(store.callsOf("createWaitState")[0]).toMatchObject({
      waitType: "event",
    });
    expect(store.callsOf("markWaitStateStatus")[0]?.status).toBe("resumed");
  });

  // The node output is the arriving Event's payload and nothing of the signal
  // envelope that carried it, which is what makes `payload.<field>` the path the
  // catalog's field list promises rather than `payload.data.payload.<field>`.
  it("outputs the arriving Event's payload without the signal envelope", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: waitResumeSignal({ orderId: "ord_7" }),
    });
    const result = await execution;

    expect(waitOutput(result).payload).toEqual({ orderId: "ord_7" });

    // The path the catalog offers for this node, walked the way a template and
    // the condition builder walk it.
    const nodeOutput = result.outputs.wait_1?.data ?? null;
    expect(resolveOutputPath(nodeOutput, "payload.orderId")).toBe("ord_7");
    expect(resolveOutputPath(nodeOutput, "waitType")).toBe("event");
  });

  // A wait holds a race between the Events it subscribes to, and the payloads of
  // two Events can be shaped alike. Naming the winner is the only thing that
  // lets a Condition below the wait tell them apart.
  it("names which of several subscribed Events resumed the run", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          { event: "billing/payment.settled" },
          { event: "billing/payment.failed" },
        ],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: waitResumeSignal({ id: "pay_1" }, "billing/payment.failed"),
    });
    const result = await execution;

    expect(waitOutput(result).event).toBe("billing/payment.failed");

    // The path the catalog offers, walked the way the condition builder walks it.
    const nodeOutput = result.outputs.wait_1?.data ?? null;
    expect(resolveOutputPath(nodeOutput, "event")).toBe(
      "billing/payment.failed"
    );
  });

  // A resume that carried no payload still answers an object, so a template
  // reaching into it resolves to nothing rather than failing the node.
  it("outputs an empty payload when the signal carried none", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: { data: { signalType: "wait-resume" } },
    });
    const result = await execution;

    expect(waitOutput(result).payload).toEqual({});
  });

  // A Cancel Event wakes a parked run through the same envelope. The wake closes
  // the wait as cancelled, hands back no resume payload, and stops the branch
  // where it stands: the run's verdict is the flag on its execution row, and a
  // branch run reads no flag of its own (ADR-0011), so anything below this node
  // would be work done for a run already ending.
  it("closes the wait as cancelled when a lifecycle cancel wakes it", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: {
        data: { signalType: "lifecycle-cancel", payload: { reason: "gone" } },
      },
    });
    const result = await execution;

    expect(result.success).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      waitType: "event",
      timedOut: false,
    });
    expect(waitOutput(result)).not.toHaveProperty("payload");
    // A cancel wake is not one of the Events the builder subscribed to, so the
    // node names none.
    expect(waitOutput(result)).not.toHaveProperty("event");
    expect(store.callsOf("markWaitStateStatus")[0]?.status).toBe("cancelled");
    expect(runtime.waits.at(0)?.options.ifExpression).toContain(
      'async.data.signalType == "lifecycle-cancel"'
    );
    // Nothing below the wait ran: the entry node and the wait are the whole of
    // what opened a row.
    expect(store.callsOf("startStepLog").map((open) => open.nodeId)).toEqual([
      "lifecycle_1",
      "wait_1",
    ]);
  });

  // A wait with no end is an immortal run, so the timeout the editor writes is
  // applied here too rather than being left to whatever Inngest would pick.
  it("falls back to the default timeout when the config names none", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
      },
      store,
      resumeEvent: {},
    });
    await execution;

    expect(runtime.waits.at(0)?.options.timeoutMs).toBeGreaterThan(0);
    expect(store.callsOf("createWaitState")[0]?.metadata).toMatchObject({
      waitTimeout: "7d",
      waitTimeoutBehavior: "continue",
    });
  });

  it("records a timeout when the signal never arrives", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "30m",
      },
      store,
      resumeEvent: null,
    });
    const result = await execution;

    expect(waitOutput(result)).toMatchObject({ timedOut: true });
    expect(store.callsOf("markWaitStateStatus")[0]?.status).toBe("timed_out");
    expect(store.callsOf("recordAuditEvent").map((c) => c.eventType)).toEqual([
      "run_waiting",
      "run_timed_out",
      "run_completed",
    ]);
  });

  it("copies the subscribed Event names onto the wait row", async () => {
    // The delivery fan-out finds parked runs by this column, so the node config
    // and the row have to agree entry for entry.
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          { event: "appointment.confirmed" },
          { event: "appointment.cancelled" },
        ],
        waitTimeout: "1d",
      },
      store,
      resumeEvent: {},
    });
    await execution;

    expect(store.callsOf("createWaitState")[0]?.subscribedEvents).toEqual([
      "appointment.confirmed",
      "appointment.cancelled",
    ]);
  });

  // The whole of the wait bug, pinned: a run started by one Event parks on a
  // different one, and what it compares is the arriving payload against a value
  // only this run knows. The run side is a literal by the time it is stored.
  it("resolves the run side of a match to a literal at park time", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          {
            event: "billing/payment.settled",
            match: matchOn(
              "appointmentId",
              "{{@lifecycle_1:Lifecycle.appointment.id}}"
            ),
          },
        ],
        waitTimeout: "7d",
      },
      store,
      startPayload: { appointment: { id: "appt_8813" } },
      resumeEvent: {},
    });
    await execution;

    expect(store.callsOf("createWaitState")[0]?.metadata).toMatchObject({
      waitFor: [
        {
          event: "billing/payment.settled",
          match: {
            expression:
              '((has(payload.appointmentId) && (payload.appointmentId == "appt_8813")))',
            timestampPaths: [],
          },
        },
      ],
    });
  });

  it("stores no expression for a subscription carrying no match", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: {},
    });
    await execution;

    expect(store.callsOf("createWaitState")[0]?.metadata).toMatchObject({
      waitFor: [{ event: "billing/payment.settled" }],
    });
  });

  // A reference the resolver cannot answer is left as the authored text, so
  // compiling it would park the run on a comparison against the literal
  // `{{...}}` -- a wait nothing can wake, quiet until its timeout runs out.
  it("fails the node when a match still names a node that did not run", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          {
            event: "billing/payment.settled",
            match: matchOn(
              "appointmentId",
              "{{@no_such_node:Gone.appointment.id}}"
            ),
          },
        ],
        waitTimeout: "7d",
      },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(executionError(result.results.wait_1)).toContain(
      "is not available to this run"
    );
    expect(runtime.waits).toHaveLength(0);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
  });

  // Parking without the match would subscribe the run to every occurrence of
  // that Event, which is the opposite of what the builder wrote.
  it("fails the node when a match will not compile", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [
          { event: "billing/payment.settled", match: matchOn("id", "") },
        ],
        waitTimeout: "7d",
      },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(executionError(result.results.wait_1)).toContain(
      "billing/payment.settled"
    );
    expect(runtime.waits).toHaveLength(0);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
  });

  it("fails the node when the configured timeout cannot be parsed", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "whenever",
      },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(waitStepLogs(store).closed[0]?.status).toBe("error");
  });

  it("parks with no Correlation Path in sight", async () => {
    // The match is the matcher, so a run whose start carried no entity still
    // parks. The failure this replaces refused the wait outright.
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      store,
      resumeEvent: {},
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(true);
    expect(store.callsOf("createWaitState")).toHaveLength(1);
  });

  it("halts the branch on timeout when configured to skip", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "5m",
        waitTimeoutBehavior: "skip",
      },
      store,
      resumeEvent: null,
    });
    const result = await execution;

    expect(waitHaltedBranch(result)).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      skipped: true,
      skippedReason: "timeout_skip",
    });
  });

  // A wait can outlive several edits to the node it parked on. The timeout
  // behaviour comes off the memoized preparation, so the run finishes the way it
  // started rather than reading a config that has moved underneath it.
  //
  // The two passes are the real sequence: a run parks, and the pass that closes
  // the wait out is a separate invocation, replaying the preparation from the
  // memo and reaching the resume step for the first time. Dropping that step's
  // entry is what models the suspend this in-memory runtime does not perform.
  it("keeps the timeout behaviour the run parked with across an edit", async () => {
    const memo = new Map<string, unknown>();
    const parked = {
      waitMode: "event",
      waitFor: [{ event: "billing/payment.settled" }],
      waitTimeout: "5m",
      waitTimeoutBehavior: "skip",
    };

    await runWait({ config: parked, store, memo, resumeEvent: null }).execution;
    memo.delete("wait-event-resume-wait_1-0");

    const result = await runWait({
      config: { ...parked, waitTimeoutBehavior: "continue" },
      store,
      memo,
      resumeEvent: null,
    }).execution;

    expect(waitHaltedBranch(result)).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      skipped: true,
      skippedReason: "timeout_skip",
    });
  });
});

/**
 * A Migration's wake, as the service that moves an Execution to a later
 * Workflow Version sends it: the same envelope a resume travels in, carrying
 * `version-migrate` instead.
 */
function waitMigrateSignal() {
  return {
    name: "workflow/wait.signal",
    id: "evt_migrate",
    ts: 0,
    data: {
      executionId: "exec_wait",
      nodeId: "wait_1",
      token: "token_1",
      signalType: "version-migrate",
    },
  };
}

/**
 * Drives a Wait whose config changes once the run is parked, which is what a
 * Migration looks like from inside the run: Inngest calls the function body
 * again from the top on every wake, and the body loads the graph from the
 * version the execution row now names. The wait-state row is the switch,
 * because the first park is what writes it.
 */
function runMigratedWait(options: {
  store: RecordingWorkflowStore;
  parked: Record<string, unknown>;
  migrated: Record<string, unknown>;
  events: Record<string, unknown>;
}) {
  return driveWithReplay(
    (runtime) =>
      executeWorkflow(
        {
          graph: createWaitGraph(
            options.store.callsOf("createWaitState").length === 0
              ? options.parked
              : options.migrated
          ),
          executionId: "exec_wait",
          workflowId: "workflow_wait",
        },
        runtime,
        options.store,
        noWorkflowActions
      ),
    { events: options.events }
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe("wait node - migration to a later workflow version", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("re-parks a delay wait on the next attempt, measured from the first park's anchor", async () => {
    const run = await runMigratedWait({
      store,
      parked: { waitMode: "delay", waitDuration: "1h" },
      migrated: { waitMode: "delay", waitDuration: "3d" },
      events: { "wait-delay-wait_1-0": waitMigrateSignal() },
    });

    // One row, written over rather than joined by a second.
    const created = store.callsOf("createWaitState");
    const reparked = store.callsOf("reparkWaitState");
    expect(created).toHaveLength(1);
    expect(reparked).toHaveLength(1);
    expect(reparked[0]?.waitStateId).toBe("wait_state_1");
    // The whole park is written over, wait type and token included.
    expect(reparked[0]?.waitType).toBe("delay");
    expect(reparked[0]?.resumeToken).toBeNull();
    expect(reparked[0]?.subscribedEvents).toEqual([]);

    // Three days from where the run first parked, not from where it woke. The
    // first park's target is an hour past that anchor.
    const anchorAt = Date.parse(String(created[0]?.waitUntilIso)) - HOUR_MS;
    expect(Date.parse(String(reparked[0]?.waitUntilIso))).toBe(
      anchorAt + 3 * DAY_MS
    );

    const stepIds = run.executed.map((step) => step.stepId);
    expect(stepIds).toContain("wait-delay-prepare-wait_1-1");
    expect(stepIds).toContain("wait-delay-resume-wait_1-1");
    expect(stepIds).not.toContain("wait-delay-resume-wait_1-0");

    expect(waitOutput(run.value)).toMatchObject({
      waitType: "delay",
      hops: 2,
    });
  });

  it("recompiles an event wait's subscriptions and timeout on the next attempt", async () => {
    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      migrated: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.failed" }],
        waitTimeout: "7d",
      },
      events: {
        "wait-event-wait_1-0": waitMigrateSignal(),
        "wait-event-wait_1-1": waitResumeSignal(
          { id: "pay_1" },
          "billing/payment.failed"
        ),
      },
    });

    const created = store.callsOf("createWaitState");
    const reparked = store.callsOf("reparkWaitState");
    expect(created[0]?.subscribedEvents).toEqual(["billing/payment.settled"]);
    expect(reparked).toHaveLength(1);
    expect(reparked[0]?.subscribedEvents).toEqual(["billing/payment.failed"]);
    // The token the row already carries addresses the new park too.
    expect(reparked[0]?.resumeToken).toBe(created[0]?.resumeToken);

    // The timeout still runs out where the first park put it.
    expect(reparked[0]?.waitUntilIso).toBe(created[0]?.waitUntilIso);

    expect(waitOutput(run.value)).toMatchObject({
      waitType: "event",
      timedOut: false,
      event: "billing/payment.failed",
      payload: { id: "pay_1" },
      hops: 2,
    });
  });

  it("does not skip a wait that already waited when the recomputed target has passed", async () => {
    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "delay",
        waitDuration: "1h",
        waitGateMode: "require_actual_wait",
      },
      migrated: {
        waitMode: "delay",
        waitDuration: "-1h",
        waitGateMode: "require_actual_wait",
      },
      events: { "wait-delay-wait_1-0": waitMigrateSignal() },
    });

    // The gate asks whether this Wait ever waited, and the first attempt waited
    // an hour.
    expect(waitHaltedBranch(run.value)).toBe(false);
    const output = waitOutput(run.value);
    expect(output.skipped).toBeUndefined();
    // The second attempt had nothing left to wait for, so the run parked once
    // in all.
    expect(output.hops).toBe(1);
    expect(run.executed.map((step) => step.stepId)).toContain(
      "wait-delay-resume-wait_1-1"
    );
  });
  // Between a Migration's wake and the next park the row is still `waiting`, so
  // a resume claim can take it and send a signal nothing is parked on. The claim
  // writes its arrival onto the row, and the refused re-park is what sends the
  // Wait to read it.
  it("resumes from the arrival recorded on a row that left waiting", async () => {
    store.reparkAnswer = false;
    store.waitState = {
      status: "resumed",
      arrival: {
        signalType: "wait-resume",
        eventName: "billing/payment.settled",
        payload: { id: "pay_1" },
      },
    };

    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      migrated: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      events: { "wait-event-wait_1-0": waitMigrateSignal() },
    });

    expect(store.callsOf("readWaitState")).toEqual([
      { waitStateId: "wait_state_1" },
    ]);
    expect(waitOutput(run.value)).toMatchObject({
      waitType: "event",
      timedOut: false,
      event: "billing/payment.settled",
      payload: { id: "pay_1" },
      // The second attempt read the arrival instead of parking again.
      hops: 1,
    });
    expect(waitHaltedBranch(run.value)).toBe(false);
  });

  it("takes the cancel path when the row was cancelled between two parks", async () => {
    store.reparkAnswer = false;
    store.waitState = { status: "cancelled", arrival: null };

    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      migrated: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      events: { "wait-event-wait_1-0": waitMigrateSignal() },
    });

    expect(store.callsOf("markWaitStateStatus").at(-1)?.status).toBe(
      "cancelled"
    );
    expect(waitHaltedBranch(run.value)).toBe(true);
  });

  it("fails the node when the row that left waiting records no wake", async () => {
    store.reparkAnswer = false;
    store.waitState = { status: "timed_out", arrival: null };

    const run = await runMigratedWait({
      store,
      parked: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      migrated: {
        waitMode: "event",
        waitFor: [{ event: "billing/payment.settled" }],
        waitTimeout: "7d",
      },
      events: { "wait-event-wait_1-0": waitMigrateSignal() },
    });

    expect(run.value.results.wait_1?.success).toBe(false);
    expect(executionError(run.value.results.wait_1)).toContain(
      "records no wake"
    );
  });

  // The pointer can move after Inngest has resolved the park and before the
  // resume step runs, which would let the attempt carry on under the graph this
  // body loaded. The step fails instead, and Inngest retries the body against
  // the version the row now names.
  it("fails its step when the run has been moved to another workflow version", async () => {
    store.pinnedVersionId = "ver_test";

    const run = driveWithReplay(
      (runtime) => {
        // The Migration lands while the run is parked, so every step after the
        // first park reads a version this body did not load.
        if (store.callsOf("createWaitState").length > 0) {
          store.pinnedVersionId = "ver_2";
        }
        return executeWorkflow(
          {
            graph: createWaitGraph({ waitMode: "delay", waitDuration: "1h" }),
            executionId: "exec_wait",
            workflowId: "workflow_wait",
          },
          runtime,
          store,
          noWorkflowActions
        );
      },
      { events: { "wait-delay-wait_1-0": waitMigrateSignal() } }
    );

    await expect(run).rejects.toMatchObject({
      message: expect.stringContaining("moved to another workflow version"),
    });
  });
});
