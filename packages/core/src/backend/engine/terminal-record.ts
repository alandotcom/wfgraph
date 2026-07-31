/**
 * The terminal row and timeline event a finished run leaves behind, on the path
 * that walked its graph to the end and on the one that died on an error.
 */

import type { RunLogger } from "#src/backend/engine/contracts";
import type {
  WorkflowRunAuditEventType,
  WorkflowStore,
} from "#src/backend/engine/store";

/**
 * How a run that walked its graph to the end finished. `canceled` is a run that
 * left the Started branch for the Canceled one, whether or not that branch had
 * anything to run.
 */
export type TraversalTerminalStatus = "completed" | "failed" | "canceled";

/** How a run that reached the end of its graph is worded on the timeline. */
function buildRunCompletedMessage(
  runMode: "live" | "test",
  status: TraversalTerminalStatus
): string {
  if (status === "canceled") {
    return runMode === "test"
      ? "Test mode canceled at the Canceled outlet"
      : "Run canceled at the Canceled outlet";
  }
  if (runMode === "test") {
    return status === "completed"
      ? "Test mode completed successfully"
      : "Test mode completed with errors";
  }
  return status === "completed"
    ? "Run completed successfully"
    : "Run completed with errors";
}

function buildRunFailedMessage(
  runMode: "live" | "test",
  cancelled: boolean
): string {
  if (runMode === "test") {
    return cancelled
      ? "Test mode cancelled"
      : "Test mode failed with fatal error";
  }
  return cancelled
    ? "Run cancelled while waiting"
    : "Run failed with fatal error";
}

const RUN_COMPLETED_AUDIT_EVENT = {
  completed: "run_completed",
  failed: "run_failed",
  canceled: "run_cancelled",
} as const satisfies Record<TraversalTerminalStatus, WorkflowRunAuditEventType>;

/**
 * Writes the terminal record and timeline event for a run that finished its
 * graph. Runs inside a durable step, so it must stay side-effect-idempotent
 * from the caller's point of view: nothing here feeds back into the traversal.
 */
export async function recordRunCompleted(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: TraversalTerminalStatus;
  output: unknown;
  error?: string;
  startTime: number;
  duration: number;
  resultCount: number;
  runMode: "live" | "test";
  logger: RunLogger;
}) {
  let recorded = true;

  try {
    recorded = await input.store.completeRun({
      executionId: input.executionId,
      status: input.status,
      output: input.output,
      error: input.error,
      startTime: input.startTime,
    });
    input.logger.debug("Updated execution record", { status: input.status });
  } catch (error) {
    input.logger.error("Failed to update execution record", { error });
  }

  // A completion that lost to a cancellation must not announce itself: the
  // timeline's last word has to match the row's terminal status.
  if (recorded) {
    await input.store.recordAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: RUN_COMPLETED_AUDIT_EVENT[input.status],
      message: buildRunCompletedMessage(input.runMode, input.status),
      metadata: {
        duration: input.duration,
        resultCount: input.resultCount,
        runMode: input.runMode,
      },
    });
  } else {
    input.logger.info("Run completion superseded by cancellation", {
      status: input.status,
    });
  }

  return { status: input.status };
}

/**
 * Terminal record for a run that died on an error escaping the traversal
 * (including a cancellation while waiting).
 */
export async function recordRunFailed(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: "failed" | "canceled";
  cancelled: boolean;
  error: string;
  startTime: number;
  runMode: "live" | "test";
  logger: RunLogger;
}) {
  let recorded = true;

  try {
    recorded = await input.store.completeRun({
      executionId: input.executionId,
      status: input.status,
      error: input.error,
      startTime: input.startTime,
    });
  } catch (logError) {
    input.logger.error("Failed to persist fatal execution error", {
      error: logError,
    });
  }

  // Same rule as `recordRunCompleted`: a terminal write this run lost must not
  // announce itself. A superseded run is the case that makes it load-bearing --
  // its row stays `superseded`, and a "Run cancelled" line on the timeline would
  // contradict it.
  if (recorded) {
    await input.store.recordAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: input.cancelled ? "run_cancelled" : "run_failed",
      message: buildRunFailedMessage(input.runMode, input.cancelled),
      metadata: {
        error: input.error,
        runMode: input.runMode,
      },
    });
  } else {
    input.logger.info("Run failure superseded by an earlier terminal status", {
      status: input.status,
    });
  }

  return { status: input.status };
}
