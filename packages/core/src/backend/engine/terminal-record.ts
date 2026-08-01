/**
 * The terminal row and timeline event a finished run leaves behind, on the path
 * that walked its graph to the end and on the one that died on an error.
 */

import type { RunLogger } from "#src/backend/engine/contracts";
import type {
  CompleteRunInput,
  RecordAuditEventInput,
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

const TERMINAL_AUDIT_EVENT = {
  completed: "run_completed",
  failed: "run_failed",
  canceled: "run_cancelled",
} as const satisfies Record<TraversalTerminalStatus, WorkflowRunAuditEventType>;

/**
 * Writes a run's terminal row, then announces the outcome when that write
 * claimed the row. Resolves through any failure: an error escaping here sends
 * `core.ts` down its fatal path, which records the run a second time.
 */
async function writeTerminalRecord(input: {
  store: WorkflowStore;
  logger: RunLogger;
  run: CompleteRunInput;
  announcement: RecordAuditEventInput;
}): Promise<void> {
  try {
    const claimed = await input.store.completeRun(input.run);

    if (!claimed) {
      input.logger.info("Run did not claim the terminal record", {
        status: input.run.status,
      });
      return;
    }
  } catch (error) {
    // The port forbids a rejection here, so this guards an adapter breaking its
    // contract rather than an outcome the engine expects.
    input.logger.error("Failed to write the terminal run record", { error });
    return;
  }

  try {
    await input.store.recordAuditEvent(input.announcement);
  } catch (error) {
    input.logger.error("Failed to announce the run's outcome", { error });
  }
}

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
  resultCount: number;
  runMode: "live" | "test";
  logger: RunLogger;
}) {
  await writeTerminalRecord({
    store: input.store,
    logger: input.logger,
    run: {
      executionId: input.executionId,
      status: input.status,
      output: input.output,
      error: input.error,
    },
    announcement: {
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: TERMINAL_AUDIT_EVENT[input.status],
      message: buildRunCompletedMessage(input.runMode, input.status),
      metadata: {
        resultCount: input.resultCount,
        runMode: input.runMode,
      },
    },
  });

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
  error: string;
  runMode: "live" | "test";
  logger: RunLogger;
}) {
  await writeTerminalRecord({
    store: input.store,
    logger: input.logger,
    run: {
      executionId: input.executionId,
      status: input.status,
      error: input.error,
    },
    announcement: {
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: TERMINAL_AUDIT_EVENT[input.status],
      message: buildRunFailedMessage(
        input.runMode,
        input.status === "canceled"
      ),
      metadata: {
        error: input.error,
        runMode: input.runMode,
      },
    },
  });

  return { status: input.status };
}
