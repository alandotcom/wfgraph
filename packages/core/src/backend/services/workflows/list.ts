import { orderBy } from "es-toolkit/array";
import { Effect } from "effect";
import type {
  WorkflowListItemPayload,
  WorkflowSummaryPayload,
} from "@wfgraph/shared/graph/api-contracts";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import {
  ExecutionRepo,
  type WorkflowRunStateCounts,
} from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { toWorkflowSummaryPayload } from "#src/backend/services/workflows/mappers";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = () =>
  Effect.map(AppLogger, (appLogger) => appLogger.get("list"));

/** A workflow with no runs, or one the count read has not seen yet. */
const NO_RUNS = { failedRecently: 0, waiting: 0 };

/** Every workflow's summary, most recently updated first. */
export const listWorkflowSummaries = Effect.fn("listWorkflowSummaries")(
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

/**
 * Every workflow's failed and waiting run counts, in one read whatever the
 * number of workflows (`ExecutionRepo.countRunStatesByWorkflow`).
 */
export const readWorkflowRunCounts = Effect.fn("readWorkflowRunCounts")(
  function* () {
    const executions = yield* ExecutionRepo;
    return yield* executions.countRunStatesByWorkflow;
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(loggerFor(), "Failed to get workflows")
      )
    )
);

/** The summaries in their order, each with its workflow's run counts. */
export function withRunCounts(
  summaries: readonly WorkflowSummaryPayload[],
  counts: readonly WorkflowRunStateCounts[]
): WorkflowListItemPayload[] {
  // Keyed by the workflow's id, a value the database generated.
  const countsById = new Map(
    counts.map(({ workflowId, failedRecently, waiting }) => [
      workflowId,
      { failedRecently, waiting },
    ])
  );
  return summaries.map((summary) => ({
    ...summary,
    runCounts: countsById.get(summary.id) ?? NO_RUNS,
  }));
}

/**
 * Every workflow, most recently updated first, each with its run counts. Two
 * reads answer the whole list, whatever the number of workflows.
 */
export const getWorkflows = Effect.fn("getWorkflows")(function* () {
  const [summaries, counts] = yield* Effect.all(
    [listWorkflowSummaries(), readWorkflowRunCounts()],
    { concurrency: 2 }
  );
  return withRunCounts(summaries, counts);
});
