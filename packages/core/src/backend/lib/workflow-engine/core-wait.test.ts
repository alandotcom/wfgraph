/**
 * Coverage for the Wait node, driven through the engine so the wait's
 * interaction with both ports is exercised: the durable runtime it suspends on
 * and the store it records its wait state in.
 *
 * The Wait node is the one node the engine never wraps in a step - Inngest
 * forbids a sleep or an event wait inside a step - so it memoizes its own
 * persistence segments around those boundaries. That is what these tests pin.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createSerializedWorkflowGraph } from "@/shared/workflow/graph";
import type { WorkflowNode } from "@/shared/workflow/types";
import { executeWorkflow } from "./core";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "./recording-store";
import { createInMemoryWorkflowRuntime } from "./runtime";

// Keeps step-handler's own logging (used by the trigger step) off a database.
mock.module("@/backend/lib/workflow-logging", () => ({
  logStepStartDb: () =>
    Promise.resolve({ logId: "mock-log-id", startTime: Date.now() }),
  logStepCompleteDb: () => Promise.resolve(),
  logWorkflowCompleteDb: () => Promise.resolve(),
}));

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
  correlationKey?: string;
  memo?: Map<string, unknown>;
};

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
      eventContext: options.correlationKey
        ? { correlationKey: options.correlationKey }
        : undefined,
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

    const stepLogs = store.callsOf("startStepLog");
    expect(stepLogs).toHaveLength(1);
    expect(stepLogs[0]?.nodeType).toBe("Wait");
    expect(store.callsOf("completeStepLog")).toEqual([
      expect.objectContaining({ logId: "log_1", status: "success" }),
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
    expect(store.callsOf("completeStepLog")[0]).toMatchObject({
      logId: "log_1",
      status: "error",
    });
  });

  it("reuses the memoized wait state and step log across a replay", async () => {
    const memo = new Map<string, unknown>();
    const config = { waitMode: "delay", waitDuration: "1h" };

    await runWait({ config, store, memo }).execution;
    await runWait({ config, store, memo }).execution;

    expect(store.callsOf("createWaitState")).toHaveLength(1);
    expect(store.callsOf("startStepLog")).toHaveLength(1);
    expect(store.callsOf("completeRun")).toHaveLength(1);
  });
});

describe("wait node - hook mode", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("waits on the signal event scoped to this run, node, and token", async () => {
    const { runtime, execution } = runWait({
      config: { waitMode: "hook", waitHookToken: "token_abc" },
      store,
      resumeEvent: { data: { approved: true } },
    });
    const result = await execution;

    expect(result.success).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      waitType: "hook",
      hookToken: "token_abc",
      timedOut: false,
      payload: { data: { approved: true } },
    });

    const wait = runtime.waits.at(0);
    expect(wait?.stepId).toBe("wait-hook-wait_1");
    expect(wait?.options.event).toBe("workflow/wait.signal");
    expect(wait?.options.ifExpression).toContain("'token_abc'");
    expect(wait?.options.ifExpression).toContain(
      "async.data.nodeId == 'wait_1'"
    );
    // No waitTimeout configured means the runtime picks its own ceiling.
    expect(wait?.options.timeoutMs).toBeUndefined();

    expect(store.callsOf("createWaitState")[0]).toMatchObject({
      waitType: "hook",
      hookToken: "token_abc",
    });
    expect(store.callsOf("markWaitStateStatus")[0]?.status).toBe("resumed");
  });

  it("generates a hook token when the node does not pin one", async () => {
    const { execution } = runWait({
      config: { waitMode: "hook" },
      store,
      resumeEvent: {},
    });
    await execution;

    const hookToken = store.callsOf("createWaitState")[0]?.hookToken;
    expect(typeof hookToken).toBe("string");
    expect(hookToken).not.toBe("");
  });

  it("records a timeout when the signal never arrives", async () => {
    const { execution } = runWait({
      config: { waitMode: "hook", waitTimeout: "30m" },
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

  it("fails the node when the configured timeout cannot be parsed", async () => {
    const { execution } = runWait({
      config: { waitMode: "hook", waitTimeout: "whenever" },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(store.callsOf("completeStepLog")[0]?.status).toBe("error");
  });
});

describe("wait node - event mode", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("fails before waiting when the trigger supplied no correlation key", async () => {
    const { runtime, execution } = runWait({
      config: { waitMode: "event" },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(result.results.wait_1?.error).toContain("correlation key");
    expect(runtime.waits).toHaveLength(0);
    // The failure is still logged as a step, opened and closed in one unit.
    expect(store.callsOf("startStepLog")).toHaveLength(1);
    expect(store.callsOf("completeStepLog")[0]?.status).toBe("error");
  });

  it("carries the trigger's correlation key onto the wait state", async () => {
    const { execution } = runWait({
      config: { waitMode: "event" },
      store,
      correlationKey: "donor_42",
      resumeEvent: {},
    });
    await execution;

    expect(store.callsOf("createWaitState")[0]?.correlationKey).toBe(
      "donor_42"
    );
  });

  it("halts the branch on timeout when configured to skip", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "event",
        waitTimeout: "5m",
        waitTimeoutBehavior: "skip",
      },
      store,
      correlationKey: "donor_42",
      resumeEvent: null,
    });
    const result = await execution;

    expect(result.results.wait_1?.haltBranch).toBe(true);
    expect(waitOutput(result)).toMatchObject({
      skipped: true,
      skippedReason: "timeout_skip",
    });
  });
});
