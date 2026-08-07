import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Conflict, InvalidInput } from "#src/backend/lib/effect/failures";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import {
  toWorkflowApiPayload,
  withDefaultLifecycleNode,
} from "#src/backend/services/workflows/mappers";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
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
      return yield* new InvalidInput({ error: "Workflow name is required" });
    }

    const nameTaken = yield* repo.hasWithName(workflowName);
    if (nameTaken) {
      yield* logger.warn("Duplicate workflow name on create", { workflowName });
      return yield* new Conflict({
        error: `Workflow name "${workflowName}" already exists`,
      });
    }

    const workflowId = generateId();
    const prepared = yield* prepareGraphSave({
      graph: withDefaultLifecycleNode(body.graph),
    }).pipe(
      // A refused query is not a rejected graph: it says nothing a builder can
      // act on, and the policy below logs it with its cause.
      Effect.tapError((failure) =>
        "error" in failure
          ? logger.warn("Rejected workflow create", {
              workflowName,
              error: failure.error,
            })
          : Effect.void
      )
    );

    const newWorkflow = yield* repo.insert({
      id: workflowId,
      name: workflowName,
      description: body.description,
      graph: prepared.graph,
      // Subscriptions wait for publish: an Event must not start a draft.
      eventSubscriptions: [],
    });

    yield* logger.info("Workflow created", {
      workflowId,
      workflowName,
      nodeCount: prepared.nodes.length,
      edgeCount: prepared.edgeCount,
    });

    return toWorkflowApiPayload(newWorkflow, null);
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(loggerFor(), "Failed to create workflow")
      )
    )
);
