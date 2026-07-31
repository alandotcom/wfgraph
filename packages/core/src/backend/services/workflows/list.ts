import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { toWorkflowSummaryPayload } from "#src/backend/services/workflows/mappers";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = () =>
  Effect.map(AppLogger, (appLogger) => appLogger.get("workflow", "list"));

export const getWorkflows = Effect.fn("getWorkflows")(
  function* () {
    const repo = yield* WorkflowRepo;

    const allWorkflows = yield* repo.listSummariesNewestFirst;

    return allWorkflows.map(toWorkflowSummaryPayload);
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(loggerFor(), "Failed to get workflows")
      )
    )
);
