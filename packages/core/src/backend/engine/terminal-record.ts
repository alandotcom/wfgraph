/**
 * The terminal row and timeline event a finished run leaves behind, on the path
 * that walked its graph to the end and on the one that died on an error.
 */

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

/**
 * Appends the recipients a test run sent to. Run mode records recipients only. A
 * Draft run always carries `test` whatever the workflow's Published mode is, so
 * this line names the recipients and leaves the graph that ran to the run row
 * beside it.
 */
function withRecipients(message: string, runMode: "live" | "test"): string {
  return runMode === "test" ? `${message} (test recipients)` : message;
}

/** How a run that reached the end of its graph is worded on the timeline. */
function buildRunCompletedMessage(
  runMode: "live" | "test",
  status: TraversalTerminalStatus
): string {
  if (status === "canceled") {
    return withRecipients("Run canceled at the Canceled outlet", runMode);
  }
  return withRecipients(
    status === "completed"
      ? "Run completed successfully"
      : "Run completed with errors",
    runMode
  );
}

function buildRunFailedMessage(
  runMode: "live" | "test",
  cancelled: boolean
): string {
  return withRecipients(
    cancelled ? "Run cancelled while waiting" : "Run failed with fatal error",
    runMode
  );
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
  run: CompleteRunInput;
  announcement: RecordAuditEventInput;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const completion = yield* input.store.completeRun(input.run).pipe(
      Effect.map((claimed) => ({ kind: "answer" as const, claimed })),
      Effect.catchTag("DatabaseError", (error) =>
        Effect.logWarning("Terminal run record not written").pipe(
          Effect.annotateLogs({
            executionId: input.run.executionId,
            status: input.run.status,
            error,
          }),
          Effect.as({ kind: "database_error" as const })
        )
      )
    );

    if (completion.kind === "database_error") {
      return;
    }

    if (!completion.claimed) {
      yield* Effect.logInfo("Run did not claim the terminal record").pipe(
        Effect.annotateLogs({ status: input.run.status })
      );
      return;
    }

    yield* Effect.catchCause(
      input.store.recordAuditEvent(input.announcement),
      (cause) =>
        Effect.logError("Failed to announce the run's outcome").pipe(
          Effect.annotateLogs({
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
  failure?: EngineFailure | undefined;
  resultCount: number;
  runMode: "live" | "test";
}): Effect.Effect<{ status: TraversalTerminalStatus }> {
  return Effect.as(
    writeTerminalRecord({
      store: input.store,
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
}): Effect.Effect<{ status: "failed" | "canceled" }> {
  return Effect.as(
    writeTerminalRecord({
      store: input.store,
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
