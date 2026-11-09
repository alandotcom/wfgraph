/**
 * The engine's verdict on a run, on the path that walked its graph to the end
 * and on the one that died on an error. The store decides from the verdict and
 * the run's claim what to write (`decideRunEnd`), and the timeline entry rides
 * on the terminal write, which commits both or neither.
 */

import type {
  CompleteRunInput,
  ExecutionTerminationState,
  PendingCancel,
  StoreFailure,
  WorkflowStore,
} from "#src/backend/engine/store";
import { Effect } from "effect";
import { type EngineFailure } from "#src/backend/engine/engine-failure";
import {
  exitOutcome,
  type CanceledOutletOutcome,
  type RunExitContext,
  type RunExitOutcome,
} from "@wfgraph/shared/lifecycle/run-ending";
import type { WorkflowExecutionStatus } from "@wfgraph/shared/lifecycle/execution-contracts";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";

/** How a run that walked its graph to the end finished. */
export type TraversalTerminalStatus =
  | "completed"
  | "failed"
  | "canceled"
  | "exited";

/**
 * What `recordRunFailed` is asked to write: a run that died with no Cancel
 * claim standing, or a canceled run together with what became of its Canceled
 * outlet. The outlet outcome belongs to the canceled case alone, so a failed
 * record cannot carry one.
 */
export type RunFailureOutcome =
  | { kind: "failed" }
  | { kind: "canceled"; outlet: CanceledOutletOutcome };

type RecordedEnding = {
  status: WorkflowExecutionStatus;
  exit?: RunExitOutcome | undefined;
  cancelClaim?: PendingCancel | undefined;
};

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
 * Writes the verdict and reads back what the store made of it. A store failure
 * is logged and fails the enclosing durable step, so the executor retries the
 * step.
 *
 * A Cancel claim that refused the verdict comes back as `cancelClaim`, with
 * nothing written and `status` still the in-flight status the row holds, so the
 * caller runs the Canceled outlet for that claim and then records `canceled`.
 * An Exit claim the verdict did not know of ends the run `exited`.
 */
function recordVerdict(input: {
  store: WorkflowStore;
  run: CompleteRunInput;
}): Effect.Effect<RecordedEnding, StoreFailure> {
  const { ending } = input.run;
  return Effect.gen(function* () {
    const state = yield* input.store.completeRun(input.run).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Terminal run record not written").pipe(
          Effect.annotateLogs({
            executionId: input.run.executionId,
            status: ending.status,
            error,
          })
        )
      )
    );
    const cancelClaim = refusingCancelClaim(state);
    if (state && cancelClaim) {
      yield* Effect.logInfo(
        "A Cancel claim refused the terminal record; the Canceled outlet runs next"
      ).pipe(Effect.annotateLogs({ status: ending.status }));
      return { status: state.status, cancelClaim };
    }
    const status = state?.status ?? ending.status;
    if (state && !state.didWrite) {
      yield* Effect.logInfo("Run did not claim the terminal record").pipe(
        Effect.annotateLogs({ status })
      );
    }
    return {
      status,
      exit: exitOutcome(state?.claim, ending.exitContext),
    };
  });
}

/**
 * Writes the terminal record and timeline event for a completed traversal.
 *
 * `canceledOutlet` is what became of the Canceled outlet the caller ran for a
 * Cancel claim that refused this record's first attempt. It is absent on every
 * other call, including a traversal that reached the outlet on its own.
 */
export function recordRunCompleted(input: {
  store: WorkflowStore;
  executionId: string;
  status: TraversalTerminalStatus;
  output: unknown;
  failure?: EngineFailure | undefined;
  resultCount: number;
  exitContext?: RunExitContext | undefined;
  canceledOutlet?: CanceledOutletOutcome | undefined;
}): Effect.Effect<RecordedEnding, StoreFailure> {
  return recordVerdict({
    store: input.store,
    run: {
      executionId: input.executionId,
      ending: {
        kind: "verdict",
        status: input.status,
        output: input.output,
        exitContext: input.exitContext,
        reached: {
          kind: "walked",
          resultCount: input.resultCount,
          error: input.failure?.message,
          canceledOutlet: input.canceledOutlet,
        },
      },
    },
  });
}

/**
 * Terminal record for an error escaping the traversal.
 *
 * `outcome` is the canceled case when the run had entered the Canceled outlet
 * before the error, and it carries what the caller did about that outlet.
 */
export function recordRunFailed(input: {
  store: WorkflowStore;
  executionId: string;
  outcome: RunFailureOutcome;
  failure: EngineFailure;
  exitContext?: RunExitContext | undefined;
}): Effect.Effect<RecordedEnding, StoreFailure> {
  return recordVerdict({
    store: input.store,
    run: {
      executionId: input.executionId,
      ending: {
        kind: "verdict",
        status: input.outcome.kind,
        exitContext: input.exitContext,
        reached: {
          kind: "fatal",
          error: input.failure.message,
          failureKind: input.failure.kind,
          canceledOutlet:
            input.outcome.kind === "canceled"
              ? input.outcome.outlet
              : undefined,
        },
      },
    },
  });
}
