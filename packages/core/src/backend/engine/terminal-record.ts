/**
 * The terminal row and timeline event a finished run leaves behind, on the path
 * that walked its graph to the end and on the one that died on an error.
 */

import type {
  CompleteRunInput,
  ExecutionTerminationState,
  RecordAuditEventInput,
  WorkflowRunAuditEventType,
  WorkflowStore,
} from "#src/backend/engine/store";
import { Cause, Effect } from "effect";
import { type EngineFailure } from "#src/backend/engine/engine-failure";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import type {
  EntityEligibilityReason,
  WorkflowExecutionStatus,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";

/** How a run that walked its graph to the end finished. */
export type TraversalTerminalStatus =
  | "completed"
  | "failed"
  | "canceled"
  | "exited";

export type RunExitOutcome = {
  reason: EntityEligibilityReason;
  entityType: string;
  conditionId: string;
  nodeId: string;
  checkedAt: string;
};

type RunExitContext = Pick<RunExitOutcome, "entityType" | "conditionId">;

/** Appends the recipients a test run sent to. */
function withRecipients(message: string, runMode: "live" | "test"): string {
  return runMode === "test" ? `${message} (test recipients)` : message;
}

function buildRunCompletedMessage(
  runMode: "live" | "test",
  status: TraversalTerminalStatus
): string {
  if (status === "canceled") {
    return withRecipients("Run canceled at the Canceled outlet", runMode);
  }
  if (status === "exited") {
    return withRecipients(
      "Run exited because the Entity was ineligible",
      runMode
    );
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
  status: TraversalTerminalStatus
): string {
  return withRecipients(
    status === "canceled"
      ? "Run cancelled while waiting"
      : status === "exited"
        ? "Run exited because the Entity was ineligible"
        : "Run failed with fatal error",
    runMode
  );
}

const TERMINAL_AUDIT_EVENT = {
  completed: "run_completed",
  failed: "run_failed",
  canceled: "run_cancelled",
  exited: "run_exited",
} as const satisfies Record<TraversalTerminalStatus, WorkflowRunAuditEventType>;

function isTraversalTerminal(
  status: WorkflowExecutionStatus
): status is TraversalTerminalStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "canceled" ||
    status === "exited"
  );
}

function isInFlight(status: ExecutionTerminationState["status"]): boolean {
  return IN_FLIGHT_EXECUTION_STATUSES.some((candidate) => candidate === status);
}

function claimedStatus(
  state: ExecutionTerminationState
): "canceled" | "exited" | undefined {
  return state.claim?.kind === "cancel"
    ? "canceled"
    : state.claim?.kind === "exit"
      ? "exited"
      : undefined;
}

/**
 * Attempts the caller's verdict, then finalizes a racing Cancel or Exit claim.
 * The returned state is authoritative, so the engine never reports its stale
 * local traversal verdict after persistence selected another outcome. A
 * `DatabaseError` from either write is logged and fails the enclosing durable
 * step, so Inngest retries the step. `null` means the store found no execution
 * row.
 */
function finalizeRun(input: {
  store: WorkflowStore;
  run: CompleteRunInput;
}): Effect.Effect<ExecutionTerminationState | null, DatabaseError> {
  return Effect.gen(function* () {
    const first = yield* input.store.completeRun(input.run).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Terminal run record not written").pipe(
          Effect.annotateLogs({
            executionId: input.run.executionId,
            status: input.run.status,
            error,
          })
        )
      )
    );
    if (!first || first.didWrite || !isInFlight(first.status)) {
      return first;
    }

    const status = claimedStatus(first);
    if (!status) {
      return first;
    }

    const claimedRun: CompleteRunInput =
      status === "exited"
        ? { ...input.run, status, failure: undefined }
        : { ...input.run, status };
    return yield* input.store.completeRun(claimedRun).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Claimed terminal run record not written").pipe(
          Effect.annotateLogs({
            executionId: input.run.executionId,
            status,
            error,
          })
        )
      )
    );
  });
}

function exitMetadata(
  state: ExecutionTerminationState,
  context: RunExitContext | undefined
): RunExitOutcome | undefined {
  return state.claim?.kind === "exit" && context
    ? {
        reason: state.claim.reason,
        entityType: context.entityType,
        conditionId: context.conditionId,
        nodeId: state.claim.nodeId,
        checkedAt: state.claim.requestedAt,
      }
    : undefined;
}

function announce(
  store: WorkflowStore,
  announcement: RecordAuditEventInput
): Effect.Effect<void> {
  return Effect.catchCause(store.recordAuditEvent(announcement), (cause) =>
    Effect.logError("Failed to announce the run's outcome").pipe(
      Effect.annotateLogs({ error: Cause.squash(cause) })
    )
  );
}

/** Writes the terminal record and timeline event for a completed traversal. */
export function recordRunCompleted(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: TraversalTerminalStatus;
  output: unknown;
  failure?: EngineFailure | undefined;
  resultCount: number;
  runMode: "live" | "test";
  exitContext?: RunExitContext | undefined;
}): Effect.Effect<
  {
    status: WorkflowExecutionStatus;
    exit?: RunExitOutcome | undefined;
  },
  DatabaseError
> {
  return Effect.gen(function* () {
    const state = yield* finalizeRun({
      store: input.store,
      run: {
        executionId: input.executionId,
        status: input.status,
        output: input.output,
        failure: input.failure,
      },
    });
    const status = state?.status ?? input.status;
    const exit = state ? exitMetadata(state, input.exitContext) : undefined;
    if (!state?.didWrite) {
      if (state) {
        yield* Effect.logInfo("Run did not claim the terminal record").pipe(
          Effect.annotateLogs({ status })
        );
      }
      return { status, ...(exit ? { exit } : {}) };
    }
    if (!isTraversalTerminal(status)) {
      return { status };
    }

    yield* announce(input.store, {
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: TERMINAL_AUDIT_EVENT[status],
      message: buildRunCompletedMessage(input.runMode, status),
      metadata: exit
        ? {
            resultCount: input.resultCount,
            runMode: input.runMode,
            ...exit,
            checkpoint: "before-node",
          }
        : { resultCount: input.resultCount, runMode: input.runMode },
    });
    return { status, ...(exit ? { exit } : {}) };
  });
}

/** Terminal record for an error escaping the traversal. */
export function recordRunFailed(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  status: "failed" | "canceled";
  failure: EngineFailure;
  runMode: "live" | "test";
  exitContext?: RunExitContext | undefined;
}): Effect.Effect<
  {
    status: WorkflowExecutionStatus;
    exit?: RunExitOutcome | undefined;
  },
  DatabaseError
> {
  return Effect.gen(function* () {
    const state = yield* finalizeRun({
      store: input.store,
      run: {
        executionId: input.executionId,
        status: input.status,
        failure: input.failure,
      },
    });
    const status = state?.status ?? input.status;
    const exit = state ? exitMetadata(state, input.exitContext) : undefined;
    if (!state?.didWrite) {
      if (state) {
        yield* Effect.logInfo("Run did not claim the terminal record").pipe(
          Effect.annotateLogs({ status })
        );
      }
      return { status, ...(exit ? { exit } : {}) };
    }
    if (!isTraversalTerminal(status)) {
      return { status };
    }

    yield* announce(input.store, {
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: TERMINAL_AUDIT_EVENT[status],
      message: buildRunFailedMessage(input.runMode, status),
      metadata: exit
        ? {
            ...exit,
            checkpoint: "before-node",
            runMode: input.runMode,
          }
        : {
            error: input.failure.message,
            failureKind: input.failure.kind,
            runMode: input.runMode,
          },
    });
    return { status, ...(exit ? { exit } : {}) };
  });
}
