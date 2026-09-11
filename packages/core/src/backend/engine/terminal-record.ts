/**
 * The terminal row and timeline event a finished run leaves behind, on the path
 * that walked its graph to the end and on the one that died on an error.
 */

import type {
  CompleteRunInput,
  ExecutionTerminationState,
  PendingCancel,
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

/**
 * What the timeline says about a run a fatal error ended. A canceled run says
 * whether the Canceled outlet was entered before the error, because a Cancel
 * claim found only by the terminal write takes the status without the outlet.
 */
function buildRunFailedMessage(
  runMode: "live" | "test",
  status: TraversalTerminalStatus,
  canceledOutlet: CanceledOutletOutcome
): string {
  return withRecipients(
    status === "canceled"
      ? canceledOutlet === "entered"
        ? "Run canceled at the Canceled outlet, then ended on a fatal error"
        : "Run canceled after a fatal error; the Canceled outlet did not run"
      : status === "exited"
        ? "Run exited because the Entity was ineligible"
        : "Run failed with fatal error",
    runMode
  );
}

/**
 * Whether a run the fatal path records as canceled had entered the Canceled
 * outlet before the error. Recorded on the `run_cancelled` audit row.
 */
type CanceledOutletOutcome = "entered" | "not_run";

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

/**
 * The Cancel claim that refused this terminal write, or undefined when the
 * write landed, the run had already ended, or no Cancel claim stands.
 */
function refusingCancelClaim(
  state: ExecutionTerminationState | null
): PendingCancel | undefined {
  return state &&
    !state.didWrite &&
    isInFlight(state.status) &&
    state.claim?.kind === "cancel"
    ? { eventName: state.claim.eventName, payload: state.claim.payload }
    : undefined;
}

/**
 * Writes the status a standing Cancel or Exit claim selected, after the run's
 * own verdict was refused. A `DatabaseError` is logged and fails the enclosing
 * durable step, so Inngest retries the step.
 */
function writeClaimedStatus(input: {
  store: WorkflowStore;
  run: CompleteRunInput;
}): Effect.Effect<ExecutionTerminationState | null, DatabaseError> {
  return input.store.completeRun(input.run).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Claimed terminal run record not written").pipe(
        Effect.annotateLogs({
          executionId: input.run.executionId,
          status: input.run.status,
          error,
        })
      )
    )
  );
}

/**
 * Attempts the caller's verdict, then finalizes a racing Exit claim. The
 * returned state is authoritative, so the engine never reports its stale local
 * traversal verdict after persistence selected another outcome.
 *
 * A racing Cancel claim is returned unwritten, still in flight, because what
 * follows it depends on the caller: a run that finished its traversal takes
 * the Canceled outlet before it records canceled, and a run a fatal error
 * ended records canceled at once. A `DatabaseError` from either write is logged
 * and fails the enclosing durable step, so Inngest retries the step. `null`
 * means the store found no execution row.
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
    if (
      !first ||
      first.didWrite ||
      !isInFlight(first.status) ||
      first.claim?.kind !== "exit"
    ) {
      return first;
    }

    return yield* writeClaimedStatus({
      store: input.store,
      run: { ...input.run, status: "exited", failure: undefined },
    });
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

/**
 * Writes the terminal record and timeline event for a completed traversal.
 *
 * A Cancel claim that refused the write comes back as `cancelClaim`, with
 * nothing written and `status` still the in-flight status the row holds. The
 * caller runs the Canceled outlet for that claim and then records `canceled`.
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
  exitContext?: RunExitContext | undefined;
}): Effect.Effect<
  {
    status: WorkflowExecutionStatus;
    exit?: RunExitOutcome | undefined;
    cancelClaim?: PendingCancel | undefined;
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
    const cancelClaim = refusingCancelClaim(state);
    if (state && cancelClaim) {
      yield* Effect.logInfo(
        "A Cancel claim refused the terminal record; the Canceled outlet runs next"
      ).pipe(Effect.annotateLogs({ status: input.status }));
      return { status: state.status, cancelClaim };
    }
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

/**
 * Terminal record for an error escaping the traversal.
 *
 * `status` is `canceled` when the run had entered the Canceled outlet before
 * the error. A Cancel claim that refuses a `failed` verdict is recorded as
 * canceled at once, because the scheduler that would run the outlet is the
 * one that just died, and the timeline says the outlet did not run.
 */
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
    const run: CompleteRunInput = {
      executionId: input.executionId,
      status: input.status,
      failure: input.failure,
    };
    const verdict = yield* finalizeRun({ store: input.store, run });
    const state = refusingCancelClaim(verdict)
      ? yield* writeClaimedStatus({
          store: input.store,
          run: { ...run, status: "canceled" },
        })
      : verdict;
    const canceledOutlet: CanceledOutletOutcome =
      input.status === "canceled" ? "entered" : "not_run";
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
      message: buildRunFailedMessage(input.runMode, status, canceledOutlet),
      metadata: exit
        ? {
            ...exit,
            checkpoint: "before-node",
            runMode: input.runMode,
          }
        : status === "canceled"
          ? {
              error: input.failure.message,
              failureKind: input.failure.kind,
              runMode: input.runMode,
              canceledOutlet,
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
