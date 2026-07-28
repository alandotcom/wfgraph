import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import {
  InternalFailure,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { invalidateInngestFunctionsCache } from "#src/backend/lib/inngest/functions";
import { validateWorkflowConditionConfigs } from "#src/backend/lib/workflow-conditions-validation";
import { validateWorkflowGraph } from "#src/backend/lib/workflow-graph";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  buildWorkflowUpdateData,
  toWorkflowApiPayload,
  withDefaultTriggerNode,
} from "#src/backend/services/workflows/mappers";
import { generateId } from "@rova/shared/utils/id";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = () =>
  Effect.map(AppLogger, (appLogger) => appLogger.get("workflow", "current"));

export const getWorkflowsCurrent = Effect.fn("getWorkflowsCurrent")(
  function* () {
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor();

    const currentWorkflow = yield* repo.findCurrent();

    if (!currentWorkflow) {
      // Answering with a bare empty graph would be a workflow payload missing
      // its name, mode, and timestamps, which is not a workflow.
      return yield* Effect.fail(new NotFound({ error: "No current workflow" }));
    }

    const graphValidation = validateWorkflowGraph(currentWorkflow.graph);
    if (!graphValidation.valid) {
      yield* logger.error("Stored current workflow has invalid graph", {
        error: graphValidation.error,
      });
      return yield* Effect.fail(
        new InternalFailure({
          error: "Stored current workflow graph is invalid",
        })
      );
    }

    // Conditions are checked on save and again before a run, never on the way
    // out: refusing the read would leave the editor unable to open the graph
    // whose condition needs correcting.
    return toWorkflowApiPayload(currentWorkflow);
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(),
          "Failed to get current workflow"
        )
      )
    )
);

export const postWorkflowsCurrent = Effect.fn("postWorkflowsCurrent")(
  function* (body: { graph: unknown }) {
    const repo = yield* WorkflowRepo;

    const graphValidation = validateWorkflowGraph(
      withDefaultTriggerNode(body.graph)
    );
    if (!graphValidation.valid) {
      return yield* Effect.fail(
        new InvalidInput({ error: graphValidation.error })
      );
    }

    const conditionValidation = validateWorkflowConditionConfigs(
      graphValidation.nodes
    );
    if (!conditionValidation.valid) {
      return yield* Effect.fail(
        new InvalidInput({ error: conditionValidation.error })
      );
    }

    const existingWorkflow = yield* repo.findCurrent();

    if (existingWorkflow) {
      const updatedWorkflow = yield* repo.update(
        existingWorkflow.id,
        buildWorkflowUpdateData({ graph: graphValidation.graph })
      );

      if (!updatedWorkflow) {
        // The row was read a moment ago, so losing it here means something
        // deleted it mid-save; there is no newer graph to answer with.
        return yield* Effect.fail(
          new InternalFailure({ error: "Failed to save current workflow" })
        );
      }

      return toWorkflowApiPayload(updatedWorkflow);
    }

    const savedWorkflow = yield* repo.insertCurrent({
      id: generateId(),
      graph: graphValidation.graph,
    });

    if (!savedWorkflow) {
      return yield* Effect.fail(
        new InternalFailure({ error: "Failed to save current workflow" })
      );
    }

    // Only the first save registers a function with Inngest; a later one writes
    // over a graph the cache already holds a trigger for.
    invalidateInngestFunctionsCache();

    return toWorkflowApiPayload(savedWorkflow);
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(),
          "Failed to save current workflow"
        )
      )
    )
);
