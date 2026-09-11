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
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
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
 * What became of the Canceled outlet for a run a fatal error ended. The caller
 * decides it, and the `run_cancelled` audit row carries it.
 *
 * `entered` is a run that had taken the outlet before the error. `ran` and
 * `failed` cover a Cancel claim the terminal write was the first to see: the
 * caller ran the outlet for that claim, and the outlet either finished or died
 * partway.
 */
export type CanceledOutletOutcome = "entered" | "ran" | "failed";

/**
 * What `recordRunFailed` is asked to write: a run that died with no Cancel
 * claim standing, or a canceled run together with what became of its Canceled
 * outlet. The outlet outcome belongs to the canceled case alone, so a failed
 * record cannot carry one.
 */
export type RunFailureOutcome =
  | { kind: "failed" }
  | { kind: "canceled"; outlet: CanceledOutletOutcome };

/** The `run_cancelled` message each outlet outcome is worded as. */
const CANCELED_FATAL_MESSAGE = {
  entered: "Run canceled at the Canceled outlet, then ended on a fatal error",
  ran: "Run canceled at the Canceled outlet after a fatal error",
  failed: "Run canceled after a fatal error; the Canceled outlet failed",
} as const satisfies Record<CanceledOutletOutcome, string>;

/** What the timeline says about a run a fatal error ended. */
function buildRunFailedMessage(
  runMode: "live" | "test",
  status: TraversalTerminalStatus,
  outcome: RunFailureOutcome
): string {
  if (status === "canceled" && outcome.kind === "canceled") {
    return withRecipients(CANCELED_FATAL_MESSAGE[outcome.outlet], runMode);
  }
  return withRecipients(
    status === "exited"
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
 * A racing Cancel claim is returned unwritten, still in flight, because the
 * caller takes the Canceled outlet for that claim before it records canceled.
 * A `DatabaseError` from either write is logged and fails the enclosing
 * durable step, so Inngest retries the step. `null` means the store found no
 * execution row.
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
  /**
   * What became of the Canceled outlet the caller ran for a Cancel claim that
   * refused this record's first attempt. Absent on every other call, including
   * a traversal that reached the outlet on its own.
   */
  canceledOutlet?: CanceledOutletOutcome | undefined;
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
        : omitUndefined({
            resultCount: input.resultCount,
            runMode: input.runMode,
            canceledOutlet:
              status === "canceled" ? input.canceledOutlet : undefined,
          }),
    });
    return { status, ...(exit ? { exit } : {}) };
  });
}

/**
 * Terminal record for an error escaping the traversal.
 *
 * `outcome` is the canceled case when the run had entered the Canceled outlet
 * before the error, and it carries what the caller did about that outlet.
 *
 * A Cancel claim that refuses the verdict comes back as `cancelClaim` with
 * nothing written, so the caller runs the Canceled outlet for that claim and
 * calls this again with `canceled`.
 */
export function recordRunFailed(input: {
  store: WorkflowStore;
  executionId: string;
  workflowId: string;
  outcome: RunFailureOutcome;
  failure: EngineFailure;
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
    const requestedStatus = input.outcome.kind;
    const run: CompleteRunInput = {
      executionId: input.executionId,
      status: requestedStatus,
      failure: input.failure,
    };
    const state = yield* finalizeRun({ store: input.store, run });
    const cancelClaim = refusingCancelClaim(state);
    if (state && cancelClaim) {
      return { status: state.status, cancelClaim };
    }
    const status = state?.status ?? requestedStatus;
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
      message: buildRunFailedMessage(input.runMode, status, input.outcome),
      metadata: exit
        ? {
            ...exit,
            checkpoint: "before-node",
            runMode: input.runMode,
          }
        : status === "canceled" && input.outcome.kind === "canceled"
          ? {
              error: input.failure.message,
              failureKind: input.failure.kind,
              runMode: input.runMode,
              canceledOutlet: input.outcome.outlet,
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
