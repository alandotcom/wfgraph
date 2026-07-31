import { Effect } from "effect";
import { omit } from "es-toolkit/object";
import { nanoid } from "nanoid";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureRelayingCause } from "#src/backend/lib/effect/internal-failure";
import {
  Conflict,
  InternalFailure,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { toWorkflowApiPayload } from "#src/backend/services/workflows/mappers";
import { generateId } from "@rova/shared/utils/id";
import { createSerializedWorkflowGraph } from "@rova/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/graph/types";

/**
 * A copy points at no integration: connections are per-workflow, so the person
 * who copies one picks its credentials again.
 *
 * The key is removed rather than set to `undefined`: the graph is decoded with
 * `rejectUnknownKeys`, and a key present and holding `undefined` is still a key.
 */
function stripIntegrationIds(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.map((node) => {
    const newNode: WorkflowNode = { ...node, id: nanoid() };
    const currentData = newNode.data;
    if (currentData) {
      const updatedData = { ...currentData };
      if (updatedData.config) {
        updatedData.config = omit(updatedData.config, ["integrationId"]);
      }
      updatedData.status = "idle";
      newNode.data = updatedData;
    }
    return newNode;
  });
}

function updateEdgeReferences(
  edges: WorkflowEdge[],
  oldNodes: WorkflowNode[],
  newNodes: WorkflowNode[]
): WorkflowEdge[] {
  const idMap = new Map<string, string>();
  oldNodes.forEach((oldNode, index) => {
    idMap.set(oldNode.id, newNodes[index].id);
  });

  return edges.map((edge) => ({
    ...edge,
    id: nanoid(),
    source: idMap.get(edge.source) || edge.source,
    target: idMap.get(edge.target) || edge.target,
  }));
}

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "duplicate").with({ workflowId })
  );

export const postWorkflowDuplicate = Effect.fn("postWorkflowDuplicate")(
  function* (workflowId: string) {
    const repo = yield* WorkflowRepo;
    const logger = yield* loggerFor(workflowId);

    const sourceWorkflow = yield* repo.findById(workflowId);

    if (!sourceWorkflow) {
      return yield* new NotFound({ error: "Workflow not found" });
    }

    // The graph column is untyped JSON, so a stored graph that no longer parses
    // is possible and reading it directly would throw out of the generator as a
    // defect. Validating first is the same guard `getWorkflow` puts on the same
    // column, and it hands back the nodes and edges, so nothing parses twice.
    const sourceValidation = validateWorkflowGraph(sourceWorkflow.graph);
    if (!sourceValidation.valid) {
      yield* logger.error("Stored workflow graph is invalid on duplicate", {
        reason: sourceValidation.error,
      });
      return yield* new InternalFailure({ error: "Workflow graph is invalid" });
    }

    const { nodes: oldNodes, edges: oldEdges } = sourceValidation;
    const newNodes = stripIntegrationIds(oldNodes);
    const newEdges = updateEdgeReferences(oldEdges, oldNodes, newNodes);
    const newGraph = createSerializedWorkflowGraph({
      nodes: newNodes,
      edges: newEdges,
      attributes: sourceValidation.graph.attributes,
    });

    const workflowName = `${sourceWorkflow.name} (Copy)`;
    const nameTaken = yield* repo.hasWithName(workflowName);
    if (nameTaken) {
      yield* logger.warn("Duplicate workflow name on duplicate", {
        workflowName,
      });
      return yield* new Conflict({
        error: `Workflow name "${workflowName}" already exists`,
      });
    }

    const newWorkflowId = generateId();

    // The rewrite renames every node and edge, so the copy is a graph this
    // function built rather than one it read. Checking it here is what turns our
    // own bug into a failure the caller can read instead of a row no screen can
    // load afterwards, and it derives the copy's own subscription rows.
    const prepared = yield* prepareGraphSave({ graph: newGraph }).pipe(
      Effect.catchIf(
        (failure) => "error" in failure,
        (failure) =>
          logger
            .error("Duplicated workflow graph is invalid", {
              reason: "error" in failure ? failure.error : undefined,
            })
            .pipe(
              Effect.andThen(
                Effect.fail(
                  new InternalFailure({
                    error: "Duplicated workflow graph is invalid",
                  })
                )
              )
            )
      )
    );

    const newWorkflow = yield* repo.insert({
      id: newWorkflowId,
      name: workflowName,
      description: sourceWorkflow.description,
      graph: prepared.graph,
      mode: sourceWorkflow.mode,
      visibility: "private",
      // A copy starts paused. It names the same Start Event as its source, so an
      // unpaused copy would double every run the original does from the moment it
      // exists -- and a copy is made to be edited, not to run as it is.
      isPaused: true,
      eventSubscriptions: prepared.subscriptionsFor(newWorkflowId),
    });

    yield* logger.info("Workflow duplicated", {
      sourceWorkflowName: sourceWorkflow.name,
      workflowName,
      newWorkflowId,
    });

    return toWorkflowApiPayload(newWorkflow);
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureRelayingCause(
          loggerFor(workflowId),
          "Failed to duplicate workflow"
        )
      )
    )
);
