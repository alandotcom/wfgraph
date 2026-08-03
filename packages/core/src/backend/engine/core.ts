/**
 * The engine's entry point: what a caller hands a run, and what the run leaves
 * behind once its graph is walked.
 *
 * The walk itself is `NodeScheduler`, whose state lives in `Traversal` and
 * `CancelBoundary`.
 */

import { getAppLogger } from "#src/backend/lib/logger";
import { withSpan } from "#src/backend/lib/telemetry";
import { toWorkflowGraphData } from "@rova/shared/graph/graph";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@rova/shared/graph/types";
import type { JsonObject } from "@rova/shared/types/json";
import { Cause, Effect } from "effect";
import type { WorkflowActions } from "#src/backend/engine/actions";
import type { BranchRunResult } from "#src/backend/engine/branch";
import { CancelBoundary } from "#src/backend/engine/cancel-boundary";
import {
  type ExecutionResult,
  type NodeOutputs,
  type RunLogger,
  wrapStoredOutput,
} from "#src/backend/engine/contracts";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import { NodeScheduler } from "#src/backend/engine/scheduler";
import type { WorkflowStore } from "#src/backend/engine/store";
import {
  recordRunCompleted,
  recordRunFailed,
  type TraversalTerminalStatus,
} from "#src/backend/engine/terminal-record";
import { Traversal } from "#src/backend/engine/traversal";
import {
  type EngineFailure,
  failureFromCause,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";

export type { WorkflowActions } from "#src/backend/engine/actions";
export type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
export type { WorkflowStore } from "#src/backend/engine/store";

export type WorkflowExecutionInput = {
  graph: SerializedWorkflowGraph;
  /**
   * The payload that set this run going: a manual-run input, or the data on the
   * Inngest event a Start Event arrived as. It reached the engine as JSON and is
   * written back out as JSON into `workflow_executions.input`.
   */
  startPayload?: JsonObject;
  /**
   * The Event that started the run, absent for a manual start and for the
   * execute route. A Condition node reads it as the Event the run arrived on
   * until a Cancel Event takes the run to the Canceled outlet.
   */
  startEventName?: string;
  /** The untouched payload as it arrived, before any mock request filled in. */
  requestPayload?: JsonObject;
  /**
   * Identifies the run row every log, timeline event, and wait state hangs off.
   * Required: whether a run leaves a trace is decided by which `WorkflowStore`
   * the caller injects, never by omitting an id here.
   */
  executionId: string;
  /** Owning workflow. Also how steps look up integration credentials. */
  workflowId: string;
  workflowName?: string;
  workflowRunId?: string;
  runMode?: "live" | "test";
};

/**
 * A run of the branch below one Wait node, which is a durable run of its own.
 *
 * Everything above the entry node ran in whichever run handed the branch off.
 * Its outputs reach this run through the store, and `releasedNodeIds` says which
 * of those nodes let their downstream follow, which the stored rows cannot: a
 * node that halted its branch has an output and released nothing.
 */
export type WorkflowBranchInput = WorkflowExecutionInput & {
  entryNodeId: string;
  releasedNodeIds: readonly string[];
};

const workflowExecutorLogger = getAppLogger("workflow", "executor");

/** What one call of the engine builds before it can execute a node. */
type PreparedRun = {
  nodes: readonly WorkflowNode[];
  traversal: Traversal;
  cancelBoundary: CancelBoundary;
  scheduler: NodeScheduler;
  lifecycleNodeIds: string[];
  logger: RunLogger;
};

type WorkflowExecutionResult = {
  success: boolean;
  results: Readonly<Record<string, ExecutionResult>>;
  outputs: Readonly<NodeOutputs>;
  error?: string;
  cancelled?: boolean;
};

/**
 * Builds the traversal, the cancel boundary and the scheduler one run walks
 * with.
 *
 * A branch run names its entry node, and that is the whole of the difference
 * here: its cancel boundary is inert, because the run that started the branch is
 * the one that routes a cancellation and the branch itself is killed outright.
 */
function prepareRun(
  input: WorkflowExecutionInput | WorkflowBranchInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions
): PreparedRun {
  const branchEntryNodeId =
    "entryNodeId" in input ? input.entryNodeId : undefined;
  const {
    graph,
    startPayload = {},
    startEventName = null,
    requestPayload,
    executionId,
    workflowId,
    workflowName,
    workflowRunId,
    runMode = "live",
  } = input;
  const { nodes, edges } = toWorkflowGraphData(graph);

  const currentWorkflowRunId = workflowRunId || runtime.runId || executionId;

  const logger = workflowExecutorLogger.with({
    workflowId,
    workflowName: workflowName ?? null,
    executionId,
    workflowRunId: currentWorkflowRunId,
    runMode,
    branchEntryNodeId: branchEntryNodeId ?? null,
  });

  logger.info("Starting workflow execution", {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    runMode,
    startPayload,
    requestPayload: requestPayload ?? startPayload,
  });

  const traversal = new Traversal(nodes, edges);

  const nodesWithIncoming = new Set(edges.map((e) => e.target));
  const lifecycleNodes = nodes.filter(
    (node) => node.data.type === "lifecycle" && !nodesWithIncoming.has(node.id)
  );

  const boundaryInput = {
    edges,
    traversal,
    runtime,
    store,
    executionId,
    logger,
  };
  const cancelBoundary = branchEntryNodeId
    ? CancelBoundary.inert(boundaryInput)
    : new CancelBoundary({ ...boundaryInput, lifecycleNodes });

  const scheduler = new NodeScheduler({
    traversal,
    cancelBoundary,
    runtime,
    store,
    actions,
    executionId,
    workflowId,
    workflowRunId: currentWorkflowRunId,
    runMode,
    startPayload,
    startEventName,
    branchEntryNodeId,
    logger,
  });

  return {
    nodes,
    traversal,
    cancelBoundary,
    scheduler,
    lifecycleNodeIds: lifecycleNodes.map((node) => node.id),
    logger,
  };
}

/**
 * All three ports are required. `runtime` decides how work is made durable,
 * `store` decides where the run's trace is written, and `actions` decides what
 * an action id dispatches to. None of them defaults, because a port that
 * silently does nothing reads to the caller as a working run: omitting `store`
 * would complete green having persisted nothing. The Inngest adapter in
 * lib/inngest/workflow-function.ts is where a real run picks up all three.
 */
export function executeWorkflow(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions
): Promise<WorkflowExecutionResult> {
  return withSpan(
    "rova.workflow.execution",
    {
      "rova.workflow.id": input.workflowId,
      "rova.execution.id": input.executionId,
      "rova.workflow.name": input.workflowName,
      "rova.execution.run_mode": input.runMode ?? "live",
    },
    () =>
      Effect.runPromise(executeWorkflowInner(input, runtime, store, actions))
  );
}

function executeWorkflowInner(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions
) {
  return Effect.suspend(() => {
    const { executionId, workflowId, runMode = "live" } = input;
    const {
      traversal,
      cancelBoundary,
      scheduler,
      lifecycleNodeIds,
      logger: executionLogger,
    } = prepareRun(input, runtime, store, actions);

    // This body is re-run on every attempt and after every wait, so this clock
    // measures the current attempt alone. The run's own elapsed is derived from
    // its stored `started_at` where the row is closed.
    const attemptStartTime = Date.now();

    executionLogger.info("Discovered lifecycle nodes", {
      lifecycleNodeCount: lifecycleNodeIds.length,
      lifecycleNodeIds,
    });

    const execute = Effect.gen(function* () {
      const effectContext = yield* Effect.context();
      executionLogger.info("Starting execution from lifecycle nodes");
      yield* scheduler.runAll(lifecycleNodeIds);
      // Every Wait the fan-out reached was held back, so the branches that
      // suspend nothing are finished by now and the run may park.
      yield* scheduler.drainDeferredWaits();

      const finalSuccess = traversal.allSucceeded();
      const finalOutput = traversal.deterministicTerminalOutput();
      // A cancel outranks what the nodes did: the run reached the end of the
      // Canceled branch, and that is the whole of what it means to be canceled.
      const terminalStatus: TraversalTerminalStatus =
        cancelBoundary.hasLeftStartedBranch()
          ? "canceled"
          : finalSuccess
            ? "completed"
            : "failed";

      executionLogger.info("Workflow execution completed", {
        success: finalSuccess,
        status: terminalStatus,
        resultCount: traversal.resultCount,
        attemptMs: Date.now() - attemptStartTime,
      });

      // Wrapped as a durable step so the terminal record and its audit event are
      // written exactly once, even though the body replays after every wait.
      yield* Effect.tryPromise({
        try: () =>
          runtime.run("workflow-run-completed", () =>
            Effect.runPromiseWith(effectContext)(
              recordRunCompleted({
                store,
                executionId,
                workflowId,
                status: terminalStatus,
                output: finalOutput,
                failure: traversal.firstFailure(),
                resultCount: traversal.resultCount,
                runMode,
                logger: executionLogger,
              })
            )
          ),
        catch: failureFromUnknown,
      });

      return {
        success: finalSuccess,
        results: traversal.results,
        outputs: traversal.outputs,
      };
    });

    return Effect.catchCause(execute, (cause) =>
      Effect.gen(function* () {
        const effectContext = yield* Effect.context();
        const failure = failureFromCause(cause);
        executionLogger.error("Fatal error during workflow execution", {
          error: Cause.squash(cause),
          failureKind: failure.kind,
        });

        // The flag is the authority here as it is on the success path: a run is
        // canceled because a Cancel Event claimed it, never because the text of
        // whatever died happens to contain the word.
        const cancelled = cancelBoundary.hasLeftStartedBranch();
        const terminalStatus = cancelled ? "canceled" : "failed";

        // Same exactly-once treatment as the success path above.
        yield* Effect.tryPromise({
          try: () =>
            runtime.run("workflow-run-failed", () =>
              Effect.runPromiseWith(effectContext)(
                recordRunFailed({
                  store,
                  executionId,
                  workflowId,
                  status: terminalStatus,
                  failure,
                  runMode,
                  logger: executionLogger,
                })
              )
            ),
          catch: failureFromUnknown,
        });

        return {
          success: false,
          results: traversal.results,
          outputs: traversal.outputs,
          error: failure.message,
          cancelled,
        };
      })
    );
  });
}

/**
 * Walks the branch below one Wait node, as a durable run of its own (ADR-0011).
 *
 * What it did travels back to the run that started the branch in the returned
 * value, and that run is where the Execution ends, where a cancellation routes,
 * and where a fatal error here is attributed, so this one lets an error escape.
 */
export function executeWorkflowBranch(
  input: WorkflowBranchInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions
): Promise<BranchRunResult> {
  return withSpan(
    "rova.workflow.branch",
    {
      "rova.workflow.id": input.workflowId,
      "rova.execution.id": input.executionId,
      "rova.workflow.name": input.workflowName,
      "rova.execution.run_mode": input.runMode ?? "live",
      "rova.branch.entry_node_id": input.entryNodeId,
    },
    () =>
      Effect.runPromise(
        executeWorkflowBranchInner(input, runtime, store, actions)
      )
  );
}

function executeWorkflowBranchInner(
  input: WorkflowBranchInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions
): Effect.Effect<BranchRunResult, EngineFailure> {
  return Effect.gen(function* () {
    const { entryNodeId, executionId } = input;
    const effectContext = yield* Effect.context();
    const { nodes, traversal, scheduler, logger } = prepareRun(
      input,
      runtime,
      store,
      actions
    );

    // Templates behind the Wait address the nodes above it, which this run never
    // walked. The store holds that view rather than the invoke payload, because an
    // HTTP Request step's response body is what makes those outputs large. The
    // cost is that a row whose close was refused leaves its template unresolved.
    const upstream = yield* Effect.tryPromise({
      try: () =>
        runtime.run(`branch-upstream-${entryNodeId}`, () =>
          Effect.runPromiseWith(effectContext)(
            store.readNodeOutputs(executionId)
          )
        ),
      catch: failureFromUnknown,
    });

    for (const node of nodes) {
      const data = upstream[node.id];
      if (node.id === entryNodeId || data === undefined) {
        continue;
      }
      traversal.inheritCompleted(node.id, {
        label: node.data.label || node.id,
        data: wrapStoredOutput(data),
      });
    }

    for (const nodeId of input.releasedNodeIds) {
      traversal.markReadyForDownstream(nodeId);
    }

    logger.info("Starting branch execution", {
      entryNodeId,
      inheritedNodeCount: Object.keys(upstream).length,
    });

    yield* scheduler.runAll([entryNodeId]);
    // A wait further down this branch is handed off in turn, so this run holds
    // one pause of its own and the branch below that one holds its own.
    yield* scheduler.drainDeferredWaits();

    logger.info("Branch execution completed", {
      entryNodeId,
      resultCount: traversal.resultCount,
    });

    return { results: { ...traversal.results }, outputs: traversal.ownOutputs };
  });
}
