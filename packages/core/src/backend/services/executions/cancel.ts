import { Effect } from "effect";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import {
  Conflict,
  InternalFailure,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { cancelInFlightRuns } from "#src/backend/services/executions/end-runs";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

type CancelExecutionSuccess = {
  success: true;
  status: "canceled";
  cancelledWaitStates: number;
};

/** This module's logger, as the Effect that produces it (see `services/workflows/workflow.ts`). */
const loggerFor = (executionId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "execution-cancel").with({ executionId })
  );

export const postExecutionCancel = Effect.fn("postExecutionCancel")(
  function* (executionId: string) {
    const repo = yield* ExecutionRepo;
    const logger = yield* loggerFor(executionId);

    const workflowId = yield* repo.findWorkflowIdById(executionId);

    if (!workflowId) {
      yield* logger.warn("Execution not found for cancel");
      return yield* new NotFound({ error: "Execution not found" });
    }

    // The same read `getExecutionStatus` answers a poll with, checked against
    // the statuses a run can still leave. A Lifecycle Rules Cancel Event reaches
    // every one of them (ADR-0007), so the Runs panel button does too, rather
    // than staying narrowed to a run parked on a Wait.
    const execution = yield* repo.findStatusById(executionId);
    const isInFlight =
      execution !== null &&
      IN_FLIGHT_EXECUTION_STATUSES.some(
        (status) => status === execution.status
      );

    if (!isInFlight) {
      yield* logger.warn("Execution is not in flight and cannot be cancelled");
      return yield* new Conflict({
        error: "Execution has already finished",
      });
    }

    const waitingStates = yield* repo.listWaitingStates(executionId);

    yield* repo.recordAuditEvent({
      workflowId,
      executionId,
      eventType: "run_cancel_requested",
      message: "Manual cancellation requested",
    });

    // The one run-ender a person reaches: the signal, the row behind its
    // compare-and-set, the wait rows (whatever exist -- a run standing on any
    // other node carries none), and the timeline entry are one thing. A Cancel
    // Event takes the other path, flagging the run for its Canceled outlet
    // rather than ending it (`lifecycle/cancel.ts`).
    const ended = yield* cancelInFlightRuns({
      workflowId,
      executionIds: [executionId],
      waitStates: waitingStates.map((state) => ({
        id: state.id,
        executionId,
      })),
      reason: "Cancelled manually",
    });

    if (ended.failedExecutionIds.length > 0) {
      yield* logger.warn("Cancel signal did not reach the run");
      return yield* new InternalFailure({
        error: "Failed to cancel execution",
      });
    }

    // The run had already reached a terminal status: Concurrency or another
    // cancel got there between the wait-state read and this write. It is over
    // either way, so the caller still gets a success.
    if (ended.endedExecutionIds.length === 0) {
      yield* logger.info("Execution was already terminal when cancel landed");
    }

    const cancelled: CancelExecutionSuccess = {
      success: true,
      status: "canceled",
      cancelledWaitStates: waitingStates.length,
    };
    return cancelled;
  },
  (effect, executionId) =>
    // One seam left: `cancelInFlightRuns` answers with the ids a send failed on
    // rather than failing, so the only way out of this body is a refused query.
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(executionId),
          "Failed to cancel execution"
        )
      )
    )
);
