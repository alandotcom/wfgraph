/**
 * A Wait whose park the runtime has not resolved: the runtime answers
 * `PARKED_WAIT_ANSWER`, and the run ends the pass parked rather than suspending.
 */

import { sortBy } from "es-toolkit/array";
import { beforeEach, describe, expect, it } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";
import { noWorkflowActions } from "#src/backend/engine/actions";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import {
  createInMemoryWorkflowRuntime,
  PARKED_WAIT_ANSWER,
} from "#src/backend/engine/runtime";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import {
  createLifecycleNode,
  createWaitNode,
} from "#src/backend/engine/testing/wait-fixtures";

const EXECUTION_ID = "exec_park";

const DELAY = { waitMode: "delay", waitDuration: "1h" };

const EVENT = {
  waitMode: "event",
  waitFor: [{ event: "billing/payment.settled" }],
  waitTimeout: "7d",
};

/** A Condition node that always picks its `true` branch and does no other work. */
function step(id: string): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType: "Condition", condition: true },
    },
  };
}

function edge(
  source: string,
  target: string,
  sourceHandle?: string
): WorkflowEdge {
  return sourceHandle === undefined
    ? { id: `${source}->${target}`, source, target }
    : { id: `${source}->${target}`, source, target, sourceHandle };
}

function runParked(
  store: RecordingWorkflowStore,
  graph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }
) {
  const runtime = createInMemoryWorkflowRuntime({
    resumeEvent: PARKED_WAIT_ANSWER,
  });
  return executeTestWorkflow(
    {
      graph: createSerializedWorkflowGraph(graph),
      executionId: EXECUTION_ID,
      workflowId: "workflow_park",
    },
    runtime,
    store,
    noWorkflowActions
  );
}

/**
 * Every run-log row the run opened, keyed by node, with how it was closed or
 * `running` for a row still open. The recording store numbers rows `log_<n>` in
 * the order they were opened.
 */
function logRows(store: RecordingWorkflowStore): Record<string, string> {
  const closes = new Map(
    store.callsOf("completeStepLog").map((close) => [close.logId, close.status])
  );
  return Object.fromEntries(
    store
      .callsOf("startStepLog")
      .map((open, index) => [
        open.nodeId,
        closes.get(`log_${index + 1}`) ?? "running",
      ])
  );
}

function auditEventTypes(store: RecordingWorkflowStore): string[] {
  return store.callsOf("recordAuditEvent").map((event) => event.eventType);
}

/** What a run that ended a pass parked writes, whatever else it did. */
function expectNoTerminalRecord(store: RecordingWorkflowStore) {
  expect(store.callsOf("completeRun")).toEqual([]);
  expect(auditEventTypes(store)).not.toContain("run_completed");
  expect(auditEventTypes(store)).not.toContain("run_failed");
  // Nothing resumed, so no wait row was settled and the run was never moved
  // back to running. The pass ends by asking for the run to read `waiting`.
  expect(store.callsOf("markWaitStateStatus")).toEqual([]);
  expect(store.callsOf("markExecutionRunning")).toEqual([]);
  expect(store.callsOf("markExecutionWaitingIfParked")).toEqual([
    { executionId: EXECUTION_ID },
  ]);
}

describe("a parked Wait", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("ends the pass parked, leaving the wait row waiting and its log row open", async () => {
    const result = await runParked(store, {
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createWaitNode("wait_1", EVENT),
        step("after_wait"),
      ],
      edges: [
        edge("lifecycle_1", "wait_1", "started"),
        edge("wait_1", "after_wait"),
      ],
    });

    expect(result).toMatchObject({
      kind: "parked",
      openParks: 1,
      status: "waiting",
    });
    expect(Object.keys(result.results)).toEqual(["lifecycle_1"]);
    expectNoTerminalRecord(store);

    expect(store.callsOf("createWaitState")).toEqual([
      expect.objectContaining({
        executionId: EXECUTION_ID,
        nodeId: "wait_1",
        waitType: "event",
        subscribedEvents: ["billing/payment.settled"],
      }),
    ]);
    expect(auditEventTypes(store)).toEqual(["run_waiting"]);
    expect(logRows(store)).toEqual({
      lifecycle_1: "success",
      wait_1: "running",
    });
  });

  it("counts two sibling Waits parked in one pass", async () => {
    const result = await runParked(store, {
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createWaitNode("wait_a", DELAY),
        createWaitNode("wait_b", EVENT),
        step("after_a"),
        step("after_b"),
      ],
      edges: [
        edge("lifecycle_1", "wait_a", "started"),
        edge("lifecycle_1", "wait_b", "started"),
        edge("wait_a", "after_a"),
        edge("wait_b", "after_b"),
      ],
    });

    expect(result).toMatchObject({ kind: "parked", openParks: 2 });
    expect(Object.keys(result.results)).toEqual(["lifecycle_1"]);
    expectNoTerminalRecord(store);

    expect(
      sortBy(
        store
          .callsOf("createWaitState")
          .map(({ nodeId, waitType }) => ({ nodeId, waitType })),
        ["nodeId"]
      )
    ).toEqual([
      { nodeId: "wait_a", waitType: "delay" },
      { nodeId: "wait_b", waitType: "event" },
    ]);
    expect(logRows(store)).toEqual({
      lifecycle_1: "success",
      wait_a: "running",
      wait_b: "running",
    });
  });

  it("lets a sibling branch run to its end while the Wait stays parked", async () => {
    const result = await runParked(store, {
      nodes: [
        createLifecycleNode("lifecycle_1"),
        createWaitNode("wait_1", DELAY),
        step("after_wait"),
        step("step_a"),
        step("step_b"),
      ],
      edges: [
        edge("lifecycle_1", "wait_1", "started"),
        edge("wait_1", "after_wait"),
        edge("lifecycle_1", "step_a", "started"),
        edge("step_a", "step_b", "true"),
      ],
    });

    expect(result).toMatchObject({ kind: "parked", openParks: 1 });
    expect(result.results.step_a?.success).toBe(true);
    expect(result.results.step_b?.success).toBe(true);
    expect(result.results).not.toHaveProperty("wait_1");
    expect(result.results).not.toHaveProperty("after_wait");
    expectNoTerminalRecord(store);

    expect(store.callsOf("createWaitState")).toHaveLength(1);
    expect(logRows(store)).toEqual({
      lifecycle_1: "success",
      step_a: "success",
      step_b: "success",
      wait_1: "running",
    });
  });

  it("parks behind a Condition on the branch the Condition picked", async () => {
    const result = await runParked(store, {
      nodes: [
        createLifecycleNode("lifecycle_1"),
        step("check"),
        createWaitNode("wait_1", EVENT),
        step("after_wait"),
        step("not_picked"),
      ],
      edges: [
        edge("lifecycle_1", "check", "started"),
        edge("check", "wait_1", "true"),
        edge("check", "not_picked", "false"),
        edge("wait_1", "after_wait"),
      ],
    });

    expect(result).toMatchObject({ kind: "parked", openParks: 1 });
    expect(result.results.check?.success).toBe(true);
    expect(Object.keys(result.results).toSorted()).toEqual([
      "check",
      "lifecycle_1",
    ]);
    expectNoTerminalRecord(store);

    expect(store.callsOf("createWaitState")).toEqual([
      expect.objectContaining({ nodeId: "wait_1", waitType: "event" }),
    ]);
    expect(logRows(store)).toEqual({
      lifecycle_1: "success",
      check: "success",
      wait_1: "running",
    });
  });
});
