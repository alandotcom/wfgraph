import { isEqual } from "es-toolkit/predicate";
import { orderBy } from "es-toolkit/array";
import { Duration, Effect, Stream } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { toWorkflowSummaryPayload } from "#src/backend/services/workflows/mappers";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = () =>
  Effect.map(AppLogger, (appLogger) => appLogger.get("list"));

export const getWorkflows = Effect.fn("getWorkflows")(
  function* () {
    const repo = yield* WorkflowRepo;

    const allWorkflows = yield* repo.listSummariesNewestFirst;

    return orderBy(
      allWorkflows.map(toWorkflowSummaryPayload),
      [(workflow) => workflow.updatedAt, (workflow) => workflow.id],
      ["desc", "asc"]
    );
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(loggerFor(), "Failed to get workflows")
      )
    )
);

/** Polls persisted summaries and emits the complete list after each change. */
export const streamWorkflowSummaries = Effect.fn("streamWorkflowSummaries")(
  function* (options: { readonly pollIntervalMs?: number } = {}) {
    return yield* Effect.succeed(
      Stream.tick(Duration.millis(options.pollIntervalMs ?? 500)).pipe(
        Stream.mapEffect(() => getWorkflows()),
        Stream.changesWith(isEqual)
      )
    );
  }
);
