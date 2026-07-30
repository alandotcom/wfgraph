import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import {
  ExecutionRepo,
  type WorkflowExecutionEvent,
} from "#src/backend/services/workflows/executions/repo/index";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (executionId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "execution-events").with({ executionId })
  );

/** One audit row as the wire carries it. */
function toEventItem(event: WorkflowExecutionEvent) {
  return {
    id: event.id,
    workflowId: event.workflowId,
    executionId: event.executionId,
    eventType: event.eventType,
    message: event.message,
    metadata: event.metadata,
    createdAt: event.createdAt.toISOString(),
  };
}

export const getExecutionEvents = Effect.fn("getExecutionEvents")(
  function* (executionId: string) {
    const repo = yield* ExecutionRepo;
    const logger = yield* loggerFor(executionId);

    const executionExists = yield* repo.existsById(executionId);

    if (!executionExists) {
      yield* logger.warn("Execution not found for events");
      return yield* Effect.fail(new NotFound({ error: "Execution not found" }));
    }

    const events = yield* repo.listEvents(executionId);

    return { events: events.map(toEventItem) };
  },
  (effect, executionId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(executionId),
          "Failed to get execution events"
        )
      )
    )
);
