import { orderBy } from "es-toolkit/array";
import { Effect } from "effect";
import type { WorkflowListItemPayload } from "@wfgraph/shared/graph/api-contracts";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { toWorkflowSummaryPayload } from "#src/backend/services/workflows/mappers";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = () =>
  Effect.map(AppLogger, (appLogger) => appLogger.get("list"));

/** A workflow with no runs, or one the count read has not seen yet. */
const NO_RUNS = { failedRecently: 0, waiting: 0 };

/**
 * Every workflow, most recently updated first, each with its run counts. Two
 * reads answer the whole list, whatever the number of workflows: the
 * summaries, and one count of run states across every workflow.
 */
export const getWorkflows = Effect.fn("getWorkflows")(
  function* () {
    const repo = yield* WorkflowRepo;
    const executions = yield* ExecutionRepo;

    const [allWorkflows, runStates] = yield* Effect.all(
      [repo.listSummariesNewestFirst, executions.countRunStatesByWorkflow],
      { concurrency: 2 }
    );
    // Keyed by the workflow's id, a value the database generated.
    const countsById = new Map(
      runStates.map(({ workflowId, failedRecently, waiting }) => [
        workflowId,
        { failedRecently, waiting },
      ])
    );

    return orderBy(
      allWorkflows.map((workflow): WorkflowListItemPayload => ({
        ...toWorkflowSummaryPayload(workflow),
        runCounts: countsById.get(workflow.id) ?? NO_RUNS,
      })),
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
