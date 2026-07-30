import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { callDbModule } from "#src/backend/lib/effect/database";
import {
  Conflict,
  InternalFailure,
  NotFound,
} from "#src/backend/lib/effect/failures";
import {
  asPromisePort,
  callInngestModule,
  InngestClient,
} from "#src/backend/lib/effect/inngest-client";
import { seamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import { cancelInFlightRuns } from "#src/backend/lib/workflow-cancellation";
import { listExecutionWaitingStates } from "#src/backend/lib/workflow-wait-state";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo";

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

    const waitingStates = yield* callDbModule(() =>
      listExecutionWaitingStates(executionId)
    );

    if (waitingStates.length === 0) {
      yield* logger.warn("Execution is not waiting and cannot be cancelled");
      return yield* Effect.fail(
        new Conflict({ error: "Execution is not currently waiting" })
      );
    }

    yield* callDbModule(() =>
      logWorkflowAuditEvent({
        workflowId,
        executionId,
        eventType: "run_cancel_requested",
        message: "Manual cancellation requested",
      })
    );

    // The one run-ender, which is also what a Cancel Event will reach in B7: the
    // signal, the row behind its compare-and-set, the wait rows, and the timeline
    // entry are one thing wherever a run is stopped from outside.
    const inngest = yield* InngestClient;
    const ended = yield* callInngestModule(() =>
      cancelInFlightRuns({
        requestCancel: asPromisePort(inngest.sendCancelRequested),
        workflowId,
        executionIds: [executionId],
        waitStates: waitingStates.map((state) => ({
          id: state.id,
          executionId,
        })),
        reason: "Cancelled manually",
      })
    );

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
    effect.pipe(
      Effect.catchTags(
        seamFailureHandlers(
          loggerFor(executionId),
          "Failed to cancel execution"
        )
      )
    )
);
