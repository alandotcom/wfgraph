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
import type { JsonObject } from "@rova/shared/types/json";
import { createSerializedWorkflowGraph } from "@rova/shared/workflow/graph";
import type { WorkflowNode } from "@rova/shared/workflow/types";
import { executeWorkflow } from "./core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "./recording-store";
import { createInMemoryWorkflowRuntime } from "./runtime";

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

function createWaitGraph(config: Record<string, unknown>) {
  return createSerializedWorkflowGraph({
    nodes: [createTriggerNode("trigger_1"), createWaitNode("wait_1", config)],
    edges: [{ id: "edge_1", source: "trigger_1", target: "wait_1" }],
  });
}

type RunWaitOptions = {
  config: Record<string, unknown>;
  store: RecordingWorkflowStore;
  resumeEvent?: unknown;
  triggerInput?: JsonObject;
  memo?: Map<string, unknown>;
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
 * The Wait node returns an ExecutionResult, which the engine then stores whole
 * as the node's data - so the wait's own output sits one level in.
 */
function waitOutput(result: {
  results: Record<string, { data?: unknown } | undefined>;
}) {
  const nodeData = result.results.wait_1?.data as { data?: unknown };
  return nodeData?.data as Record<string, unknown>;
}

function runWait(options: RunWaitOptions) {
  const runtime = createInMemoryWorkflowRuntime({
    skipSleep: true,
    resumeEvent: options.resumeEvent ?? null,
    memo: options.memo,
  });

  const execution = executeWorkflow(
    {
      graph: createWaitGraph(options.config),
      executionId: "exec_wait",
      workflowId: "workflow_wait",
      triggerInput: options.triggerInput,
    },
    runtime,
    options.store
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

    // Roughly an hour, allowing for the milliseconds the run itself took.
    const sleep = runtime.sleeps.find((s) => s.stepId === "wait-delay-wait_1");
    expect(sleep?.durationMs).toBeGreaterThan(3_500_000);

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

    expect(result.results.wait_1?.haltBranch).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      skipped: true,
      skippedReason: "past_due_no_wait",
    });
    // Nothing to wait for means no wait-state row and no sleep at all.
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(runtime.sleeps).toHaveLength(0);
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
      resumeEvent: { data: { approved: true } },
    });
    const result = await execution;

    expect(result.success).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      waitType: "event",
      timedOut: false,
      payload: { data: { approved: true } },
    });

    const resumeToken = store.callsOf("createWaitState")[0]?.resumeToken;
    expect(typeof resumeToken).toBe("string");
    expect(resumeToken).not.toBe("");

    const wait = runtime.waits.at(0);
    expect(wait?.stepId).toBe("wait-event-wait_1");
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
              "{{@trigger_1:Trigger.appointment.id}}"
            ),
          },
        ],
        waitTimeout: "7d",
      },
      store,
      triggerInput: { appointment: { id: "appt_8813" } },
      resumeEvent: {},
    });
    await execution;

    expect(store.callsOf("createWaitState")[0]?.metadata).toMatchObject({
      waitFor: [
        {
          event: "billing/payment.settled",
          match: {
            expression: '((payload.appointmentId == "appt_8813"))',
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
    expect(result.results.wait_1?.error).toContain(
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
    expect(result.results.wait_1?.error).toContain("billing/payment.settled");
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

  // The retired third mode has no fallback path: a saved node holding it fails
  // the decode, which is where a graph written against the old shape stops.
  it("fails a node still configured for the retired hook mode", async () => {
    const { runtime, execution } = runWait({
      config: { waitMode: "hook", waitHookToken: "token_abc" },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(result.results.wait_1?.error).toContain("configuration is invalid");
    expect(runtime.waits).toHaveLength(0);
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

    expect(result.results.wait_1?.haltBranch).toBe(true);
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
    memo.delete("wait-event-resume-wait_1");

    const result = await runWait({
      config: { ...parked, waitTimeoutBehavior: "continue" },
      store,
      memo,
      resumeEvent: null,
    }).execution;

    expect(result.results.wait_1?.haltBranch).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      skipped: true,
      skippedReason: "timeout_skip",
    });
  });
});
