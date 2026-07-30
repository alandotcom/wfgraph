import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import {
  Conflict,
  InternalFailure,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import { cancelInFlightRuns } from "#src/backend/services/workflows/executions/end-runs";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo/index";

type CancelExecutionSuccess = {
  success: true;
  status: "canceled";
  cancelledWaitStates: number;
};

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
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
      return yield* Effect.fail(new NotFound({ error: "Execution not found" }));
    }

    const waitingStates = yield* repo.listWaitingStates(executionId);

    if (waitingStates.length === 0) {
      yield* logger.warn("Execution is not waiting and cannot be cancelled");
      return yield* Effect.fail(
        new Conflict({ error: "Execution is not currently waiting" })
      );
    }

    yield* repo.recordAuditEvent({
      workflowId,
      executionId,
      eventType: "run_cancel_requested",
      message: "Manual cancellation requested",
    });

    // The one run-ender, which is also what a Cancel Event will reach in B7: the
    // signal, the row behind its compare-and-set, the wait rows, and the timeline
    // entry are one thing wherever a run is stopped from outside.
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
      return yield* Effect.fail(
        new InternalFailure({ error: "Failed to cancel execution" })
      );
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
        internalFailureRelayingCause(
          loggerFor(executionId),
          "Failed to cancel execution"
        )
      )
    )
);
