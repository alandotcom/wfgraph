import { Duration, Effect, Stream } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import {
  Conflict,
  DraftConflict,
  InternalFailure,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import {
  asPublishedVersion,
  WorkflowRepo,
} from "#src/backend/services/workflows/repo";
import {
  buildWorkflowUpdateData,
  toWorkflowApiPayload,
} from "#src/backend/services/workflows/mappers";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";

/** The contract answers a delete with this and nothing else. */
type WorkflowDeleted = { success: true };

/**
 * The version a draft still points at, resolved by the id an already-read row
 * carries rather than by re-reading `published_version_id` through the
 * workflow: a concurrent publish could otherwise pair the draft with a newer
 * version than the one it knew.
 */
export const resolvePublishedVersion = (
  repo: WorkflowRepo["Service"],
  publishedVersionId: string | null
) =>
  publishedVersionId
    ? Effect.map(repo.findVersionById(publishedVersionId), asPublishedVersion)
    : Effect.succeed(null);

/**
 * This module's logger, as the Effect that produces it.
 *
 * A generator body yields it, and the `Effect.fn` transform beside that body
 * hands the same value to the database policy, which is how one function's log
 * lines all carry the same category and the same `workflowId`.
 */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow").with({ workflowId })
  );

export const getWorkflow = Effect.fn("getWorkflow")(
  function* (workflowId: string) {
    const repo = yield* WorkflowRepo;

    const found = yield* repo.findByIdWithPublishedVersion(workflowId);

    if (!found) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    const { workflow, publishedVersion } = found;

    const graphValidation = validateWorkflowGraph(workflow.graph);
    if (!graphValidation.valid) {
      return yield* new InternalFailure({ error: "Workflow graph is invalid" });
    }

    // Conditions are checked when the graph is written and again before a run,
    // never here: a stored expression that no longer matches its model would
    // otherwise lock the user out of the editor, the one screen that can fix it.
    return toWorkflowApiPayload(workflow, publishedVersion);
  },
  // Every query this function runs answers the same way when the database
  // refuses it, so the policy is stated here once rather than at each call.
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(workflowId),
          "Failed to get workflow"
        )
      )
    )
);

/** Reads the persisted revision without loading the workflow graph. */
export const getWorkflowDraftRevision = Effect.fn("getWorkflowDraftRevision")(
  function* (workflowId: string) {
    const repo = yield* WorkflowRepo;
    const workflow = yield* repo.findDraftRevisionById(workflowId);

    if (!workflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    return {
      workflowId: workflow.id,
      draftRevision: workflow.draftRevision,
    };
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(workflowId),
          "Failed to get workflow draft revision"
        )
      )
    )
);

/** Polls persisted state and emits each newer draft revision once. */
export const streamWorkflowDraftRevisions = Effect.fn(
  "streamWorkflowDraftRevisions"
)(function* (
  input: { readonly workflowId: string; readonly afterDraftRevision: number },
  options: { readonly pollIntervalMs?: number } = {}
) {
  return yield* Effect.succeed(
    Stream.tick(Duration.millis(options.pollIntervalMs ?? 500)).pipe(
      Stream.mapEffect(() => getWorkflowDraftRevision(input.workflowId)),
      Stream.changesWith(
        (previous, current) => previous.draftRevision === current.draftRevision
      ),
      Stream.filter((event) => event.draftRevision > input.afterDraftRevision)
    )
  );
});

export const patchWorkflow = Effect.fn("patchWorkflow")(
  function* (
    workflowId: string,
    body: {
      name?: string | undefined;
      description?: string | undefined;
      graph?: unknown;
      mode?: "live" | "test" | undefined;
      expectedDraftRevision?: number | undefined;
    }
  ) {
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor(workflowId);

    const updateInput: {
      name?: string | undefined;
      description?: string | undefined;
      graph?: SerializedWorkflowGraph | undefined;
      mode?: "live" | "test" | undefined;
    } = {};
    const expectedDraftRevision = body.expectedDraftRevision;
    if (body.description !== undefined) {
      updateInput.description = body.description;
    }
    if (body.mode !== undefined) {
      if (body.mode !== "live" && body.mode !== "test") {
        return yield* new InvalidInput({
          error: "Workflow mode must be live or test",
        });
      }
      updateInput.mode = body.mode;
    }

    const existingWorkflow = yield* repo.findById(workflowId);

    if (!existingWorkflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    if (body.name !== undefined) {
      const normalizedName = body.name.trim();
      if (!normalizedName) {
        yield* logger.warn("Rejected workflow update with empty name");
        return yield* new InvalidInput({ error: "Workflow name is required" });
      }

      const nameConflict = yield* repo.hasOtherWithName({
        name: normalizedName,
        excludingWorkflowId: workflowId,
      });
      if (nameConflict) {
        yield* logger.warn("Duplicate workflow name on update", {
          workflowName: normalizedName,
        });
        return yield* new Conflict({
          error: `Workflow name "${normalizedName}" already exists`,
        });
      }

      updateInput.name = normalizedName;
    }

    if (body.graph !== undefined) {
      if (expectedDraftRevision === undefined) {
        return yield* new InvalidInput({
          error: "Expected draft revision is required for a graph update",
        });
      }
      const prepared = yield* prepareGraphSave({ graph: body.graph }).pipe(
        // A refused query is not a rejected graph: it says nothing a builder can
        // act on, and the policy below logs it with its cause.
        Effect.tapError((failure) =>
          "error" in failure
            ? logger.warn("Rejected workflow update", { error: failure.error })
            : Effect.void
        )
      );

      updateInput.graph = prepared.graph;
    }

    const updates = buildWorkflowUpdateData(updateInput);
    const updatedWorkflow =
      updateInput.graph && expectedDraftRevision !== undefined
        ? yield* repo
            .writeDraft({
              workflowId,
              expectedDraftRevision,
              updates: { ...updates, graph: updateInput.graph },
            })
            .pipe(
              Effect.flatMap((result) => {
                if (result.status === "updated") {
                  return Effect.succeed(result.workflow);
                }
                if (result.status === "conflict") {
                  return new DraftConflict({
                    error:
                      "The workflow draft changed. Reload it before saving again.",
                    currentDraftRevision: result.currentDraftRevision,
                  });
                }
                return Effect.succeed(null);
              })
            )
        : yield* repo.updateMetadata({ workflowId, updates });

    if (!updatedWorkflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

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

    const publishedVersion = yield* resolvePublishedVersion(
      repo,
      updatedWorkflow.publishedVersionId
    );

    return toWorkflowApiPayload(updatedWorkflow, publishedVersion);
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
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
      return yield* new NotFound({ error: "Workflow not found" });
    }

    yield* repo.deleteById(workflowId);

    yield* logger.info("Workflow deleted");

    const result: WorkflowDeleted = { success: true };
    return result;
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(workflowId),
          "Failed to delete workflow"
        )
      )
    )
);
