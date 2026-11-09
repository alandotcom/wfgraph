/**
 * The engine's terminal write. The store decides from the verdict and the
 * run's claim what to write (`decideRunEnd`), and the timeline entry rides on
 * the terminal write, which commits both or neither.
 */

import type {
  ExecutionTerminationState,
  PendingCancel,
  StoreFailure,
  WorkflowStore,
} from "#src/backend/engine/store";
import { Effect } from "effect";
import {
  exitOutcome,
  type RunExitOutcome,
  type RunVerdict,
} from "@wfgraph/shared/lifecycle/run-ending";
import type { WorkflowExecutionStatus } from "@wfgraph/shared/lifecycle/execution-contracts";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";

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
 * step. `output` is redacted here, before it reaches the store.
 *
 * A Cancel claim that refused the verdict comes back as `cancelClaim`, with
 * nothing written and `status` still the in-flight status the row holds, so the
 * caller runs the Canceled outlet for that claim and then records `canceled`.
 */
export const recordVerdict = Effect.fnUntraced(function* (input: {
  store: WorkflowStore;
  executionId: string;
  verdict: RunVerdict;
  output?: unknown;
}): Effect.fn.Return<RecordedEnding, StoreFailure> {
  const { verdict } = input;
  const state = yield* input.store
    .completeRun({
      executionId: input.executionId,
      verdict,
      output: redactSensitiveData(input.output),
    })
    .pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Terminal run record not written").pipe(
          Effect.annotateLogs({
            run: { execution: input.executionId },
            outcome: { verdict: verdict.status },
            error,
          })
        )
      )
    );
  const cancelClaim = refusingCancelClaim(state);
  if (state && cancelClaim) {
    yield* Effect.logInfo(
      "A Cancel claim refused the terminal record; the Canceled outlet runs next"
    ).pipe(Effect.annotateLogs({ outcome: { verdict: verdict.status } }));
    return { status: state.status, cancelClaim };
  }
  const status = state?.status ?? verdict.status;
  if (state && !state.didWrite) {
    yield* Effect.logInfo("Run did not claim the terminal record").pipe(
      Effect.annotateLogs({ outcome: { verdict: verdict.status, status } })
    );
  }
  return {
    status,
    exit: exitOutcome(state?.claim, verdict.exitContext),
  };
});
