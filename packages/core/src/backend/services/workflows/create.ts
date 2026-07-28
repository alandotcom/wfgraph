import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { callDbModule } from "#src/backend/lib/effect/database";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import {
  Conflict,
  IntegrationValidationFailed,
  InvalidInput,
} from "#src/backend/lib/effect/failures";
import { invalidateInngestFunctionsCache } from "#src/backend/lib/inngest/functions";
import { validateWorkflowConditionConfigs } from "#src/backend/lib/workflow-conditions-validation";
import { validateWorkflowGraph } from "#src/backend/lib/workflow-graph";
import { validateWorkflowIntegrations } from "#src/backend/lib/workflow-integration-validation";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  toWorkflowApiPayload,
  withDefaultTriggerNode,
} from "#src/backend/services/workflows/mappers";
import { generateId } from "@rova/shared/utils/id";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = () =>
  Effect.map(AppLogger, (appLogger) => appLogger.get("workflow", "create"));

export const postWorkflowsCreate = Effect.fn("postWorkflowsCreate")(
  function* (body: { name: string; description?: string; graph: unknown }) {
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor();

    const workflowName = body.name.trim();
    if (!workflowName) {
      yield* logger.warn("Rejected workflow create request with empty name");
      return yield* Effect.fail(
        new InvalidInput({ error: "Workflow name is required" })
      );
    }

    const nameTaken = yield* repo.hasWithName(workflowName);
    if (nameTaken) {
      yield* logger.warn("Duplicate workflow name on create", { workflowName });
      return yield* Effect.fail(
        new Conflict({
          error: `Workflow name "${workflowName}" already exists`,
        })
      );
    }

    const graphValidation = validateWorkflowGraph(
      withDefaultTriggerNode(body.graph)
    );
    if (!graphValidation.valid) {
      yield* logger.warn("Rejected invalid workflow graph on create", {
        workflowName,
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
        "Rejected workflow create due to invalid condition configuration",
        {
          workflowName,
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
        "Rejected workflow create due to invalid integrations",
        {
          workflowName,
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

    const workflowId = generateId();
    const newWorkflow = yield* repo.insert({
      id: workflowId,
      name: workflowName,
      description: body.description,
      graph: graphValidation.graph,
    });

    invalidateInngestFunctionsCache();

    yield* logger.info("Workflow created", {
      workflowId,
      workflowName,
      nodeCount: graphValidation.nodes.length,
      edgeCount: graphValidation.edges.length,
    });

    return toWorkflowApiPayload(newWorkflow);
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(loggerFor(), "Failed to create workflow")
      )
    )
);
