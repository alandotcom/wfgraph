import { Effect } from "effect";
import { uniq } from "es-toolkit/array";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { deleteWorkflow } from "#src/backend/services/workflows/workflow";

type WorkflowBulkAction = "pause" | "resume" | "delete";

type WorkflowBulkLifecycleOutcome = {
  workflowId: string;
  action: WorkflowBulkAction;
  ok: boolean;
  deleted?: boolean;
  error?: string;
};

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (input: { action: WorkflowBulkAction; requested: number }) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "bulk-actions").with({
      action: input.action,
      requestedCount: input.requested,
    })
  );

/** The logger for one workflow's own verdict within a bulk action. */
const itemLoggerFor = (input: {
  workflowId: string;
  action: WorkflowBulkAction;
}) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "bulk-actions").with({
      action: input.action,
      workflowId: input.workflowId,
    })
  );

/**
 * Pause or resume one workflow, answering the same shape a deletion does.
 *
 * A pause that changes nothing writes nothing: the read that decides is also
 * the read that tells a missing workflow from a present one, and this path is
 * asked about whole selections at a time.
 *
 * A refused query is this workflow's verdict and travels no further, which is
 * the same boundary the delete branch gets from `deleteWorkflow`. Without it one
 * unlucky row would fail the whole call and the caller would learn nothing about
 * the workflows that did change.
 */
const setPausedState = Effect.fn("setWorkflowPausedState")(
  function* (input: {
    workflowId: string;
    action: WorkflowBulkAction;
    isPaused: boolean;
  }) {
    const repo = yield* WorkflowRepo;
    const existing = yield* repo.findPausedById(input.workflowId);

    if (!existing) {
      const missing: WorkflowBulkLifecycleOutcome = {
        workflowId: input.workflowId,
        action: input.action,
        ok: false,
        error: "Workflow not found",
      };
      return missing;
    }

    if (existing.isPaused !== input.isPaused) {
      yield* repo.setPaused({
        workflowId: input.workflowId,
        isPaused: input.isPaused,
      });
    }

    const changed: WorkflowBulkLifecycleOutcome = {
      workflowId: input.workflowId,
      action: input.action,
      ok: true,
    };
    return changed;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          itemLoggerFor(input),
          `Failed to ${input.action} workflow`
        )
      ),
      Effect.match({
        onSuccess: (outcome) => outcome,
        onFailure: (failure): WorkflowBulkLifecycleOutcome => ({
          workflowId: input.workflowId,
          action: input.action,
          ok: false,
          error: failure.payload.error,
        }),
      })
    )
);

/**
 * Apply one lifecycle action to a selection of workflows, best-effort.
 *
 * Every workflow gets its own verdict and one failure never sinks the batch,
 * which is what the summary counts. Deleting reuses `deleteWorkflow` rather
 * than deleting here, so the two paths cannot drift over what deleting a
 * workflow entails; its failure becomes this workflow's `error` and goes no
 * further.
 *
 * There is no function-level failure policy left to state: every query runs
 * inside the loop, and each branch has already turned a refusal into that
 * workflow's row. This function's own error channel is empty.
 */
export const postWorkflowsBulkLifecycle = Effect.fn(
  "postWorkflowsBulkLifecycle"
)(function* (input: { workflowIds: string[]; action: WorkflowBulkAction }) {
  const workflowIds = uniq(input.workflowIds);
  const logger = yield* loggerFor({
    action: input.action,
    requested: workflowIds.length,
  });

  const results = yield* Effect.forEach(
    workflowIds,
    (workflowId) =>
      input.action === "delete"
        ? deleteWorkflow(workflowId).pipe(
            Effect.match({
              onSuccess: (): WorkflowBulkLifecycleOutcome => ({
                workflowId,
                action: input.action,
                ok: true,
                deleted: true,
              }),
              onFailure: (failure): WorkflowBulkLifecycleOutcome => ({
                workflowId,
                action: input.action,
                ok: false,
                error: failure.payload.error,
              }),
            })
          )
        : setPausedState({
            workflowId,
            action: input.action,
            isPaused: input.action === "pause",
          }),
    { concurrency: "unbounded" }
  );

  const succeeded = results.filter((result) => result.ok).length;

  yield* logger.info("Completed bulk workflow lifecycle action", {
    succeeded,
    failed: results.length - succeeded,
  });

  return {
    summary: {
      requested: workflowIds.length,
      succeeded,
      failed: results.length - succeeded,
    },
    results,
  };
});
