/**
 * The graph and the signal envelopes the Wait node's own suites run against.
 *
 * Two files drive the same one-Wait graph: `core-wait.test.ts` covers what each
 * mode does with a park, and `core-wait-migrate.test.ts` covers what a Migration
 * does to one. The node ids and the execution id are part of the fixture,
 * because a wait signal addresses a run and a node by id.
 */

import { Effect } from "effect";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowNode } from "@wfgraph/shared/graph/types";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import {
  type ExecutionResult,
  executionData,
} from "#src/backend/engine/contracts";
import type { RecordingWorkflowStore } from "#src/backend/engine/recording-store";
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
