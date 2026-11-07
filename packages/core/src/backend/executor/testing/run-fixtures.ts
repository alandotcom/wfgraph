/**
 * Graphs and seeded runs for the executor's cases and the wall-clock timing
 * script: the node and edge shapes a lifecycle workflow is drawn with, and a
 * published workflow with one Execution scheduled to run.
 */

import { Effect, Layer } from "effect";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import { toWorkflowGraphData } from "@wfgraph/shared/graph/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@wfgraph/shared/graph/types";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import {
  SilentAppLoggerLayer,
  stubExecutionDriver,
  stubExtensions,
} from "#src/backend/lib/effect/test-layers";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { cancelArrival } from "#src/backend/persistence/conformance/support";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { deriveEventSubscriptions } from "#src/backend/services/workflows/lifecycle/subscriptions";

export const START_EVENT = "app/appointment.created";
export const CANCEL_EVENT = "app/appointment.canceled";

/**
 * The services a loop or pass over a backend's repositories needs besides
 * them, for one that delivers no inbox row: a catalog with no Events, a
 * silent logger, and a driver no delivery reaches.
 */
export const noDeliveryServices = Layer.mergeAll(
  SilentAppLoggerLayer,
  stubExtensions(),
  stubExecutionDriver()
);

/**
 * The loop settings a host's `createWfGraphApp` resolves when it sets none,
 * for a case that runs a loop or a tick and has no reason to choose.
 */
export const LOOP_SETTINGS = {
  concurrency: { run: 10, delivery: 1, cron: 1 },
  retention: { inboxMs: 7 * 24 * 60 * 60 * 1000, runMs: undefined },
} as const;

export function lifecycleNode(config: JsonObject = {}): WorkflowNode {
  return {
    id: "entry",
    type: "lifecycle",
    position: { x: 0, y: 0 },
    data: { label: "Appointments", type: "lifecycle", config },
  };
}

/** Lifecycle Rules whose Cancel Event routes a run to its Canceled outlet. */
export const CANCELABLE: JsonObject = {
  lifecycleRules: {
    concurrency: "unlimited",
    startEvents: [START_EVENT],
    cancelEvents: [CANCEL_EVENT],
    allowManualStart: true,
  },
};

/** An action node; `config` is handed to the action as its input. */
export function actionNode(
  id: string,
  actionType: string,
  config: JsonObject = {}
): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: { label: id, type: "action", config: { actionType, ...config } },
  };
}

export function waitNode(id: string, config: JsonObject): WorkflowNode {
  return {
    id,
    type: "action",
    position: { x: 0, y: 0 },
    data: {
      label: id,
      type: "action",
      config: { actionType: BUILT_IN_ACTION_IDS.wait, ...config },
    },
  };
}

export const delay = (waitDuration: string) => ({
  waitMode: "delay",
  waitDuration,
});

export const onEvent = (event: string, waitTimeout: string) => ({
  waitMode: "event",
  waitFor: [{ event }],
  waitTimeout,
});

export function edge(source: string, target: string, sourceHandle?: string) {
  return {
    id: `${source}->${target}`,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
  };
}

/**
 * A step a case holds open: the first call waits until the case lets it go,
 * and every later call returns at once.
 */
export function createGate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let calls = 0;
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    /** How many times the step has been called. */
    calls: () => calls,
    pass: async () => {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        await released.promise;
      }
    },
  };
}

/**
 * Inserts a workflow and publishes `graph` as its first version. A workflow's
 * name is unique, so the workflow is named after its id. With `subscribe`, the
 * workflow's Event subscriptions are derived from the graph as a save derives
 * them, so a delivered Event finds it; without, it has none.
 */
export function publishWorkflow(input: {
  workflowId: string;
  versionId: string;
  graph: SerializedWorkflowGraph;
  catalogFingerprint: string;
  subscribe?: boolean | undefined;
}): Effect.Effect<void, DatabaseError, WorkflowRepo> {
  return Effect.gen(function* () {
    const workflows = yield* WorkflowRepo;
    const eventSubscriptions =
      input.subscribe === true
        ? deriveEventSubscriptions({
            workflowId: input.workflowId,
            nodes: toWorkflowGraphData(input.graph).nodes,
          })
        : [];
    yield* workflows.insert({
      id: input.workflowId,
      name: input.workflowId,
      graph: input.graph,
      eventSubscriptions,
    });
    yield* workflows.insertPublishedVersion({
      workflowId: input.workflowId,
      versionId: input.versionId,
      version: 1,
      expectedPublishedVersionId: null,
      expectedDraftRevision: 1,
      graph: input.graph,
      draftGraph: input.graph,
      catalogFingerprint: input.catalogFingerprint,
      graphDigest: `digest-${input.versionId}`,
      eventSubscriptions,
      now: new Date(),
    });
  });
}

/**
 * Starts an Execution of a published version for `entityValue`, as the start
 * Event would, and schedules it due at `wakeAt`. Answers the Execution's id.
 */
export function startScheduledRun(input: {
  workflowId: string;
  versionId: string;
  entityValue: string;
  wakeAt: Date;
}): Effect.Effect<string, DatabaseError, ExecutionRepo> {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const started = yield* executions.startForEntity({
      execution: {
        workflowId: input.workflowId,
        workflowVersionId: input.versionId,
        startSource: "event",
        startEventName: START_EVENT,
        runMode: "live",
        entityValue: input.entityValue,
        input: {},
      },
      concurrency: "unlimited",
      supersededReason: "newer start",
      startedEntry: { message: "Event-triggered run started", metadata: {} },
      now: input.wakeAt,
    });
    if (started.status !== "started") throw new Error("Start refused");
    return started.execution.id;
  });
}

/**
 * Writes a Cancel Event the way its producer does: the Cancel claim on every
 * in-flight run of the entity, with a `cancel` wake on each of their parks
 * still waiting and each run re-queued, in one transaction. Answers the
 * claimed Execution ids.
 */
export function cancelEntity(input: {
  workflowId: string;
  entityValue: string;
  now: Date;
}): Effect.Effect<string[], DatabaseError, ExecutionRepo> {
  return Effect.gen(function* () {
    const executions = yield* ExecutionRepo;
    const claims = yield* executions.requestCancelForEntity({
      workflowId: input.workflowId,
      runMode: "live",
      entityValue: input.entityValue,
      eventName: CANCEL_EVENT,
      payload: {},
      deliveryId: yield* cancelArrival(),
      now: input.now,
    });
    return claims.map((claim) => claim.executionId);
  });
}
