import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import {
  DraftConflict,
  InternalFailure,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import {
  buildWorkflowUpdateData,
  toWorkflowApiPayload,
  withDefaultLifecycleNode,
} from "#src/backend/services/workflows/mappers";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { resolvePublishedVersion } from "#src/backend/services/workflows/workflow";
import { generateId } from "@wfgraph/shared/utils/id";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = () =>
  Effect.map(AppLogger, (appLogger) => appLogger.get("current"));

export const getWorkflowsCurrent = Effect.fn("getWorkflowsCurrent")(
  function* () {
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor();

    const currentWorkflow = yield* repo.findCurrent;

    if (!currentWorkflow) {
      // Answering with a bare empty graph would be a workflow payload missing
      // its name, mode, and timestamps, which is not a workflow.
      return yield* new NotFound({ error: "No current workflow" });
    }

    const graphValidation = validateWorkflowGraph(currentWorkflow.graph);
    if (!graphValidation.valid) {
      yield* logger.error("Stored current workflow has invalid graph", {
        error: graphValidation.error,
      });
      return yield* new InternalFailure({
        error: "Stored current workflow graph is invalid",
      });
    }

    // Conditions and Lifecycle Rules are checked on save and again before a run,
    // never on the way out: refusing the read would leave the editor unable to
    // open the graph whose configuration needs correcting.
    const publishedVersion = yield* resolvePublishedVersion(
      repo,
      currentWorkflow.publishedVersionId
    );
    return toWorkflowApiPayload(currentWorkflow, publishedVersion);
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(loggerFor(), "Failed to get current workflow")
      )
    )
);

export const postWorkflowsCurrent = Effect.fn("postWorkflowsCurrent")(
  function* (body: {
    graph: unknown;
    expectedDraftRevision?: number | undefined;
  }) {
    const repo = yield* WorkflowRepo;

    const prepared = yield* prepareGraphSave({
      graph: withDefaultLifecycleNode(body.graph),
    });

    const existingWorkflow = yield* repo.findCurrent;

    if (existingWorkflow) {
      if (body.expectedDraftRevision === undefined) {
        return yield* new InvalidInput({
          error: "Expected draft revision is required for a graph update",
        });
      }
      const outcome = yield* repo.writeDraft({
        workflowId: existingWorkflow.id,
        expectedDraftRevision: body.expectedDraftRevision,
        updates: {
          ...buildWorkflowUpdateData({ graph: prepared.graph }),
          graph: prepared.graph,
        },
      });

      if (outcome.status === "conflict") {
        return yield* new DraftConflict({
          error: "The workflow draft changed. Reload it before saving again.",
          currentDraftRevision: outcome.currentDraftRevision,
        });
      }
      if (outcome.status === "not_found") {
        // The row was read a moment ago, so losing it here means something
        // deleted it mid-save; there is no newer graph to answer with.
        return yield* new InternalFailure({
          error: "Failed to save current workflow",
        });
      }
      const updatedWorkflow = outcome.workflow;

      const publishedVersion = yield* resolvePublishedVersion(
        repo,
        updatedWorkflow.publishedVersionId
      );
      return toWorkflowApiPayload(updatedWorkflow, publishedVersion);
    }

    const savedWorkflow = yield* repo.insertCurrent({
      id: generateId(),
      graph: prepared.graph,
    });

    if (!savedWorkflow) {
      return yield* new InternalFailure({
        error: "Failed to save current workflow",
      });
    }

    return toWorkflowApiPayload(savedWorkflow, null);
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(loggerFor(), "Failed to save current workflow")
      )
    )
);
