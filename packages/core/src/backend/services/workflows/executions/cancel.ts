import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { callDbModule } from "#src/backend/lib/effect/database";
import { seamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { Conflict, NotFound } from "#src/backend/lib/effect/failures";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import {
  listExecutionWaitingStates,
  markExecutionCancelled,
  markWaitingStatesCancelled,
} from "#src/backend/lib/workflow-wait-state";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo";

type CancelExecutionSuccess = {
  success: true;
  status: "cancelled";
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
    const inngest = yield* InngestClient;
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

    yield* inngest.sendCancelRequested({
      executionId,
      workflowId,
      reason: "Cancelled manually",
      requestedBy: "manual",
    });

    const cancelledWaitStateIds = yield* callDbModule(() =>
      markWaitingStatesCancelled(waitingStates.map((state) => state.id))
    );
    if (cancelledWaitStateIds.length === 0) {
      yield* logger.warn(
        "Execution wait state changed before cancel persisted"
      );
      return yield* Effect.fail(
        new Conflict({ error: "Execution is no longer waiting" })
      );
    }

    const wasInFlight = yield* callDbModule(() =>
      markExecutionCancelled({ executionId, error: "Cancelled manually" })
    );

    // A policy cancel can flip the row between the wait-state CAS and this
    // write. The run is cancelled either way, so the caller still gets a
    // success; only the duplicate audit attribution is skipped, since the
    // policy's run_cancelled entry already exists.
    if (wasInFlight) {
      yield* callDbModule(() =>
        logWorkflowAuditEvent({
          workflowId,
          executionId,
          eventType: "run_cancelled",
          message: "Run cancelled manually while waiting",
          metadata: {
            waitingStates: cancelledWaitStateIds.length,
          },
        })
      );
    }

    const cancelled: CancelExecutionSuccess = {
      success: true,
      status: "cancelled",
      cancelledWaitStates: cancelledWaitStateIds.length,
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
