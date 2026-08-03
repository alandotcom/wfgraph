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
import { Cause, Effect } from "effect";
import { type EngineFailure } from "#src/backend/engine/engine-failure";

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
 * claimed the row. A database refusal is logged and treated as an unclaimed
 * row, so neither terminal-write outcome can send `core.ts` down its fatal path
 * to record the run a second time.
 */
function writeTerminalRecord(input: {
  store: WorkflowStore;
  logger: RunLogger;
  run: CompleteRunInput;
  announcement: RecordAuditEventInput;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const completion = yield* input.store.completeRun(input.run).pipe(
      Effect.map((claimed) => ({ kind: "answer" as const, claimed })),
      Effect.catchTag("DatabaseError", (error) =>
        Effect.sync(() => {
          input.logger.warn("Terminal run record not written", {
            executionId: input.run.executionId,
            status: input.run.status,
            error,
          });
          return { kind: "database_error" as const };
        })
      )
    );

    if (completion.kind === "database_error") {
      return;
    }

    if (!completion.claimed) {
      input.logger.info("Run did not claim the terminal record", {
        status: input.run.status,
      });
      return;
    }

    yield* Effect.catchCause(
      input.store.recordAuditEvent(input.announcement),
      (cause) =>
        Effect.sync(() =>
          input.logger.error("Failed to announce the run's outcome", {
            error: Cause.squash(cause),
          })
        )
    );
  });
}

/**
 * Writes the terminal record and timeline event for a run that finished its
 * graph. Runs inside a durable step, so it must stay side-effect-idempotent
 * from the caller's point of view: nothing here feeds back into the traversal.
 */
export function recordRunCompleted(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: TraversalTerminalStatus;
  output: unknown;
  failure?: EngineFailure;
  resultCount: number;
  runMode: "live" | "test";
  logger: RunLogger;
}): Effect.Effect<{ status: TraversalTerminalStatus }> {
  return Effect.as(
    writeTerminalRecord({
      store: input.store,
      logger: input.logger,
      run: {
        executionId: input.executionId,
        status: input.status,
        output: input.output,
        failure: input.failure,
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
    }),
    { status: input.status }
  );
}

/**
 * Terminal record for a run that died on an error escaping the traversal
 * (including a cancellation while waiting).
 */
export function recordRunFailed(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: "failed" | "canceled";
  failure: EngineFailure;
  runMode: "live" | "test";
  logger: RunLogger;
}): Effect.Effect<{ status: "failed" | "canceled" }> {
  return Effect.as(
    writeTerminalRecord({
      store: input.store,
      logger: input.logger,
      run: {
        executionId: input.executionId,
        status: input.status,
        failure: input.failure,
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
          error: input.failure.message,
          failureKind: input.failure.kind,
          runMode: input.runMode,
        },
      },
    }),
    { status: input.status }
  );
}
