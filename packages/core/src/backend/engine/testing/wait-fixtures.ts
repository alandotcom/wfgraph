/**
 * The graph and the signal envelopes the Wait node's own suites run against.
 *
 * Three files drive the same one-Wait graph: the delay and Event suites cover
 * what each mode does with a park, and `core-wait-migrate.test.ts` covers what a
 * Migration does to one. The node ids and the execution id are part of the fixture,
 * because a wait signal addresses a run and a node by id.
 */

import { Effect } from "effect";
import { expect } from "vitest";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { noWorkflowActions } from "#src/backend/engine/actions";
import {
  type ExecutionResult,
  executionData,
} from "#src/backend/engine/contracts";
import type { RecordingWorkflowStore } from "#src/backend/engine/recording-store";
import { createInMemoryWorkflowRuntime } from "#src/backend/engine/runtime";
import { executeTestWorkflow } from "#src/backend/engine/test-execution";
import type {
  ExecutionTerminationState,
  WorkflowStore,
} from "#src/backend/engine/store";

/** The execution the fixture graph's runs are recorded against. */
export const WAIT_EXECUTION_ID = "exec_wait";

/** The Wait node in the fixture graph, which every signal here addresses. */
export const WAIT_NODE_ID = "wait_1";

export function createLifecycleNode(id: string): WorkflowNode {
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

export function createWaitNode(
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

/**
 * A node below the wait, so whether the wait halted its branch is a fact about
 * what ran rather than a flag on the wait's own result.
 */
export function createAfterWaitNode(): WorkflowNode {
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

export function createWaitGraph(config: Record<string, unknown>) {
  return createSerializedWorkflowGraph({
    nodes: [
      createLifecycleNode("lifecycle_1"),
      createWaitNode(WAIT_NODE_ID, config),
      createAfterWaitNode(),
    ],
    edges: [
      {
        id: "edge_1",
        source: "lifecycle_1",
        sourceHandle: "started",
        target: WAIT_NODE_ID,
      },
      { id: "edge_2", source: WAIT_NODE_ID, target: "after_wait" },
    ],
  });
}

type RunWaitOptions = {
  config: Record<string, unknown>;
  store: RecordingWorkflowStore;
  resumeEvent?: unknown;
  startPayload?: JsonObject | undefined;
  memo?: Map<string, unknown> | undefined;
  /** An execution-wide claim that lands once the run has parked. */
  claimOnPark?: ExecutionTerminationState | undefined;
};

export function runWait(options: RunWaitOptions) {
  const runtime = createInMemoryWorkflowRuntime({
    resumeEvent: options.resumeEvent ?? null,
    memo: options.memo,
  });
  const execution = executeTestWorkflow(
    {
      graph: createWaitGraph(options.config),
      executionId: WAIT_EXECUTION_ID,
      workflowId: "workflow_wait",
      startPayload: options.startPayload,
    },
    runtime,
    options.claimOnPark
      ? claimOnceParked(options.store, options.claimOnPark)
      : options.store,
    noWorkflowActions
  );

  return { runtime, execution };
}

/** The Wait node's own run-log rows. */
export function waitStepLogs(store: RecordingWorkflowStore) {
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

/** A run still in flight that holds an execution-wide claim. */
export function claimedRun(kind: "cancel" | "exit"): ExecutionTerminationState {
  return {
    status: "running",
    claim:
      kind === "exit"
        ? {
            kind: "exit",
            requestedAt: "2026-10-19T15:00:00.000Z",
            reason: "entity_condition_not_met",
            nodeId: "other_branch",
          }
        : {
            kind: "cancel",
            requestedAt: "2026-10-19T15:00:00.000Z",
            eventName: "appointment.cancelled",
            payload: null,
          },
    didWrite: false,
  };
}

const CLAIM_WAKE_MESSAGE = {
  cancel: "Run woken by a cancel request in node 'Wait'",
  exit: "Run woken by an Exit in node 'Wait'",
} as const;

/** Assert the complete result of a resume refused by an execution-wide claim. */
export function expectHaltedByClaim(
  store: RecordingWorkflowStore,
  result: Awaited<ReturnType<typeof runWait>["execution"]>,
  kind: "cancel" | "exit"
) {
  expect(result.results.wait_1?.success).toBe(true);
  expect(result.results.after_wait).toBeUndefined();
  expect(waitOutput(result)).not.toHaveProperty("payload");
  expect(waitOutput(result)).not.toHaveProperty("event");
  expect(store.callsOf("markExecutionRunning")).toEqual([
    {
      executionId: WAIT_EXECUTION_ID,
      workflowVersionId: "ver_test",
      side: "started",
    },
  ]);
  expect(store.callsOf("markWaitStateStatus")).toEqual([
    { waitStateId: "wait_state_1", status: "cancelled" },
  ]);
  expect(
    store
      .callsOf("recordAuditEvent")
      .filter((event) => event.eventType === "run_resumed")
  ).toEqual([
    expect.objectContaining({
      message: CLAIM_WAKE_MESSAGE[kind],
      metadata: { nodeId: WAIT_NODE_ID, hops: 1 },
    }),
  ]);
  expect(store.callsOf("startStepLog").map((open) => open.nodeId)).toEqual([
    "lifecycle_1",
    WAIT_NODE_ID,
  ]);
}

/**
 * A resume as `resume-waits.ts` sends it: an Inngest event whose `data` is the
 * `workflow/wait.signal` envelope, with the arriving Event's payload inside it.
 * The nesting is what the node's output has to strip.
 */
export function waitResumeSignal(
  payload: JsonObject,
  eventType: string | null = "billing/payment.settled"
) {
  const data = {
    executionId: WAIT_EXECUTION_ID,
    nodeId: WAIT_NODE_ID,
    token: "token_1",
    signalType: "wait-resume" as const,
    payload,
  };
  return {
    name: "workflow/wait.signal",
    id: "evt_signal",
    ts: 0,
    data: eventType === null ? data : { ...data, eventType },
  };
}

/**
 * A Migration's wake, as the service that moves an Execution to another
 * Workflow Version sends it: the same envelope a resume travels in, carrying
 * `version-migrate` instead.
 */
export function waitMigrateSignal() {
  return {
    name: "workflow/wait.signal",
    id: "evt_migrate",
    ts: 0,
    data: {
      executionId: WAIT_EXECUTION_ID,
      nodeId: WAIT_NODE_ID,
      token: "token_1",
      signalType: "version-migrate",
    },
  };
}

/**
 * A store that lands an execution-wide claim the moment the run parks.
 *
 * Both backends refuse a Started-side park under a claim, so a case that set the
 * claim up front would never park at all, and the case is about what reaches a
 * run that is already waiting: a resume signal whose producer took the row
 * first, or a Migration's wake.
 */
export function claimOnceParked(
  store: RecordingWorkflowStore,
  claim: ExecutionTerminationState
): WorkflowStore {
  return {
    ...store,
    createWaitState: (input) =>
      Effect.tap(store.createWaitState(input), () =>
        Effect.sync(() => {
          store.terminationState = claim;
        })
      ),
  };
}

/**
 * The Wait node returns an ExecutionResult, which the engine then stores whole
 * as the node's data, so the wait's own output sits one level in.
 */
export function waitOutput(result: {
  results: Record<string, ExecutionResult>;
}): JsonObject {
  const stored = readJsonObject(executionData(result.results[WAIT_NODE_ID]));
  return readJsonObject(stored?.data) ?? {};
}
