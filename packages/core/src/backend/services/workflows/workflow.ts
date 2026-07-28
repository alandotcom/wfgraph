import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { callDbModule } from "#src/backend/lib/effect/database";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import {
  Conflict,
  IntegrationValidationFailed,
  InternalFailure,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { invalidateInngestFunctionsCache } from "#src/backend/lib/inngest/functions";
import { validateWorkflowConditionConfigs } from "#src/backend/lib/workflow-conditions-validation";
import { validateWorkflowGraph } from "#src/backend/lib/workflow-graph";
import { validateWorkflowIntegrations } from "#src/backend/lib/workflow-integration-validation";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  buildWorkflowUpdateData,
  toWorkflowApiPayload,
} from "#src/backend/services/workflows/mappers";
import type { SerializedWorkflowGraph } from "@rova/shared/workflow/types";

/** The contract answers a delete with this and nothing else. */
type WorkflowDeleted = { success: true };

/**
 * This module's logger, as the Effect that produces it.
 *
 * A generator body yields it, and the `Effect.fn` transform beside that body
 * hands the same value to the database policy, which is how one function's log
 * lines all carry the same category and the same `workflowId`.
 */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "service").with({ workflowId })
  );

export const getWorkflow = Effect.fn("getWorkflow")(
  function* (workflowId: string) {
    const repo = yield* WorkflowRepo;

    const workflow = yield* repo.findById(workflowId);

    if (!workflow) {
      return yield* Effect.fail(new NotFound({ error: "Workflow not found" }));
    }

    const graphValidation = validateWorkflowGraph(workflow.graph);
    if (!graphValidation.valid) {
      return yield* Effect.fail(
        new InternalFailure({ error: "Workflow graph is invalid" })
      );
    }

    // Conditions are checked when the graph is written and again before a run,
    // never here: a stored expression that no longer matches its model would
    // otherwise lock the user out of the editor, the one screen that can fix it.
    return toWorkflowApiPayload(workflow);
  },
  // Every query this function runs answers the same way when the database
  // refuses it, so the policy is stated here once rather than at each call.
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(workflowId),
          "Failed to get workflow"
        )
      )
    )
);

export const patchWorkflow = Effect.fn("patchWorkflow")(
  function* (
    workflowId: string,
    body: {
      name?: string;
      description?: string;
      graph?: unknown;
      mode?: "live" | "test";
    }
  ) {
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor(workflowId);

    const updateInput: {
      name?: string;
      description?: string;
      graph?: SerializedWorkflowGraph;
      mode?: "live" | "test";
    } = {};

    if (body.description !== undefined) {
      updateInput.description = body.description;
    }
    if (body.mode !== undefined) {
      if (body.mode !== "live" && body.mode !== "test") {
        return yield* Effect.fail(
          new InvalidInput({ error: "Workflow mode must be live or test" })
        );
      }
      updateInput.mode = body.mode;
    }

    const existingWorkflow = yield* repo.findById(workflowId);

    if (!existingWorkflow) {
      return yield* Effect.fail(new NotFound({ error: "Workflow not found" }));
    }

    if (body.name !== undefined) {
      const normalizedName = body.name.trim();
      if (!normalizedName) {
        yield* logger.warn("Rejected workflow update with empty name");
        return yield* Effect.fail(
          new InvalidInput({ error: "Workflow name is required" })
        );
      }

      const nameConflict = yield* repo.hasOtherWithName({
        name: normalizedName,
        excludingWorkflowId: workflowId,
      });
      if (nameConflict) {
        yield* logger.warn("Duplicate workflow name on update", {
          workflowName: normalizedName,
        });
        return yield* Effect.fail(
          new Conflict({
            error: `Workflow name "${normalizedName}" already exists`,
          })
        );
      }

      updateInput.name = normalizedName;
    }

    if (body.graph !== undefined) {
      const graphValidation = validateWorkflowGraph(body.graph);
      if (!graphValidation.valid) {
        yield* logger.warn("Rejected invalid workflow graph on update", {
          error: graphValidation.error,
        });
        return yield* Effect.fail(
          new InvalidInput({ error: graphValidation.error })
        );
      }

      const conditionValidation = validateWorkflowConditionConfigs(
        graphValidation.nodes
      );
      if (!conditionValidation.valid) {
        yield* logger.warn(
          "Rejected workflow update due to invalid condition configuration",
          {
            error: conditionValidation.error,
          }
        );
        return yield* Effect.fail(
          new InvalidInput({ error: conditionValidation.error })
        );
      }

      // The only way this fails is the integration rows it reads, so a rejected
      // query arrives here as the same database failure a repository answers with.
      const integrationValidation = yield* callDbModule(() =>
        validateWorkflowIntegrations(graphValidation.nodes)
      );

      if (!integrationValidation.valid) {
        yield* logger.warn(
          "Rejected workflow update due to invalid integrations",
          {
            invalidIntegrationIds: integrationValidation.invalidIds,
          }
        );
        return yield* Effect.fail(
          new IntegrationValidationFailed({
            error: "Invalid integration references in workflow",
            invalidIntegrationIds: integrationValidation.invalidIds ?? [],
          })
        );
      }

      updateInput.graph = graphValidation.graph;
    }

    const updatedWorkflow = yield* repo.update(
      workflowId,
      buildWorkflowUpdateData(updateInput)
    );

    if (!updatedWorkflow) {
      return yield* Effect.fail(new NotFound({ error: "Workflow not found" }));
    }

    invalidateInngestFunctionsCache();

    const modeChanged =
      updateInput.mode !== undefined &&
      updateInput.mode !== existingWorkflow.mode;
    if (modeChanged) {
      yield* logger.info("Workflow mode changed", {
        previousMode: existingWorkflow.mode,
        nextMode: updatedWorkflow.mode,
      });
    }

    yield* logger.info("Workflow updated", {
      workflowName: updatedWorkflow.name,
      hasGraph: updateInput.graph !== undefined,
      mode: updatedWorkflow.mode,
      modeChanged,
    });

    return toWorkflowApiPayload(updatedWorkflow);
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(workflowId),
          "Failed to update workflow"
        )
      )
    )
);

export const deleteWorkflow = Effect.fn("deleteWorkflow")(
  function* (workflowId: string) {
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor(workflowId);

    const exists = yield* repo.existsById(workflowId);

    if (!exists) {
      return yield* Effect.fail(new NotFound({ error: "Workflow not found" }));
    }

    yield* repo.deleteById(workflowId);

    invalidateInngestFunctionsCache();

    yield* logger.info("Workflow deleted");

    const result: WorkflowDeleted = { success: true };
    return result;
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(workflowId),
          "Failed to delete workflow"
        )
      )
    )
);
