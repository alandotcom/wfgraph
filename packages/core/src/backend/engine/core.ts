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
import type { SerializedWorkflowGraph } from "@rova/shared/graph/types";
import type { JsonObject } from "@rova/shared/types/json";
import { getErrorMessageAsync } from "@rova/shared/utils";
import type { WorkflowActions } from "#src/backend/engine/actions";
import { CancelBoundary } from "#src/backend/engine/cancel-boundary";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import { NodeScheduler } from "#src/backend/engine/scheduler";
import type { WorkflowStore } from "#src/backend/engine/store";
import {
  recordRunCompleted,
  recordRunFailed,
  type TraversalTerminalStatus,
} from "#src/backend/engine/terminal-record";
import { Traversal } from "#src/backend/engine/traversal";

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

const workflowExecutorLogger = getAppLogger("workflow", "executor");

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
) {
  return withSpan(
    "rova.workflow.execution",
    {
      "rova.workflow.id": input.workflowId,
      "rova.execution.id": input.executionId,
      "rova.workflow.name": input.workflowName,
      "rova.execution.run_mode": input.runMode ?? "live",
    },
    () => executeWorkflowInner(input, runtime, store, actions)
  );
}

async function executeWorkflowInner(
  input: WorkflowExecutionInput,
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  actions: WorkflowActions
) {
  const {
    graph,
    startPayload = {},
    requestPayload,
    executionId,
    workflowId,
    workflowName,
    workflowRunId,
    runMode = "live",
  } = input;
  const { nodes, edges } = toWorkflowGraphData(graph);

  const currentWorkflowRunId = workflowRunId || runtime.runId || executionId;

  const executionLogger = workflowExecutorLogger.with({
    workflowId,
    workflowName: workflowName ?? null,
    executionId,
    workflowRunId: currentWorkflowRunId,
    runMode,
  });

  executionLogger.info("Starting workflow execution", {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    runMode,
    startPayload,
    requestPayload: requestPayload ?? startPayload,
  });

  const workflowStartTime = Date.now();
  const traversal = new Traversal(nodes, edges);

  const nodesWithIncoming = new Set(edges.map((e) => e.target));
  const lifecycleNodes = nodes.filter(
    (node) => node.data.type === "lifecycle" && !nodesWithIncoming.has(node.id)
  );

  executionLogger.info("Discovered lifecycle nodes", {
    lifecycleNodeCount: lifecycleNodes.length,
    lifecycleNodeIds: lifecycleNodes.map((node) => node.id),
  });

  const cancelBoundary = new CancelBoundary({
    lifecycleNodes,
    edges,
    traversal,
    runtime,
    store,
    executionId,
    logger: executionLogger,
  });

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
    logger: executionLogger,
  });

  try {
    executionLogger.info("Starting execution from lifecycle nodes");
    await scheduler.runAll(
      lifecycleNodes.map((lifecycleNode) => lifecycleNode.id)
    );

    const finalSuccess = traversal.allSucceeded();
    const duration = Date.now() - workflowStartTime;
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
      durationMs: duration,
    });

    // Wrapped as a durable step so the terminal record and its audit event are
    // written exactly once, even though the body replays after every wait.
    await runtime.step("workflow-run-completed", () =>
      recordRunCompleted({
        store,
        executionId,
        workflowId,
        status: terminalStatus,
        output: finalOutput,
        error: traversal.firstFailureMessage(),
        startTime: workflowStartTime,
        duration,
        resultCount: traversal.resultCount,
        runMode,
        logger: executionLogger,
      })
    );

    return {
      success: finalSuccess,
      results: traversal.results,
      outputs: traversal.outputs,
    };
  } catch (error) {
    executionLogger.error("Fatal error during workflow execution", {
      error,
    });

    const errorMessage = await getErrorMessageAsync(error);
    // The flag is the authority here as it is on the success path: a run is
    // canceled because a Cancel Event claimed it, never because the text of
    // whatever died happens to contain the word.
    const cancelled = cancelBoundary.hasLeftStartedBranch();
    const terminalStatus = cancelled ? "canceled" : "failed";

    // Same exactly-once treatment as the success path above.
    await runtime.step("workflow-run-failed", () =>
      recordRunFailed({
        store,
        executionId,
        workflowId,
        status: terminalStatus,
        cancelled,
        error: errorMessage,
        startTime: workflowStartTime,
        runMode,
        logger: executionLogger,
      })
    );

    return {
      success: false,
      results: traversal.results,
      outputs: traversal.outputs,
      error: errorMessage,
      cancelled,
    };
  }
}
