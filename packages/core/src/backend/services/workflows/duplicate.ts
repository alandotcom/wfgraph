import { Effect } from "effect";
import { omit } from "es-toolkit/object";
import { nanoid } from "nanoid";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { internalFailureFromCause } from "#src/backend/lib/effect/internal-failure";
import {
  Conflict,
  InternalFailure,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { validateWorkflowGraph } from "#src/backend/services/workflows/validation/workflow-graph";
import { prepareGraphSave } from "#src/backend/services/workflows/graph-save";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { toWorkflowApiPayload } from "#src/backend/services/workflows/mappers";
import { generateId } from "@wfgraph/shared/utils/id";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";

/**
 * Fresh ids for every node. Connection ids are stripped separately, just before
 * the row is written, so the copy starts unbound.
 */
function withFreshNodeIds(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.map((node) => ({ ...node, id: nanoid() }));
}

/**
 * A copy points at no integration: connections are per-workflow, so the person
 * who copies one picks its credentials again.
 *
 * The key is removed rather than set to `undefined`: the graph is decoded with
 * `rejectUnknownKeys`, and a key present and holding `undefined` is still a key.
 */
function stripIntegrationIds(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.map((node) => {
    if (!node.data.config) {
      return node;
    }
    return {
      ...node,
      data: {
        ...node.data,
        config: omit(node.data.config, ["integrationId"]),
      },
    };
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
    appLogger.get("duplicate").with({ workflowId })
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
    const newNodes = withFreshNodeIds(oldNodes);
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
    // function built rather than one it read. Checking its shape here turns our
    // own bug into a failure the caller can read, instead of a row no screen
    // can load afterwards. A copy of a half-built source duplicates as happily
    // as that source saves, because readiness is publish's question.
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

    const unboundGraph = createSerializedWorkflowGraph({
      nodes: stripIntegrationIds(prepared.nodes),
      edges: newEdges,
      attributes: prepared.graph.attributes,
    });

    const newWorkflow = yield* repo.insert({
      id: newWorkflowId,
      name: workflowName,
      description: sourceWorkflow.description,
      graph: unboundGraph,
      mode: sourceWorkflow.mode,
      visibility: "private",
      // A copy starts paused and unpublished. Subscriptions wait for publish so
      // an unpaused copy cannot double the source's Event starts until someone
      // deliberately publishes it.
      isPaused: true,
      eventSubscriptions: [],
    });

    yield* logger.info("Workflow duplicated", {
      sourceWorkflowName: sourceWorkflow.name,
      workflowName,
      newWorkflowId,
    });

    return toWorkflowApiPayload(newWorkflow, null);
  },
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTag(
        "DatabaseError",
        internalFailureFromCause(
          loggerFor(workflowId),
          "Failed to duplicate workflow"
        )
      )
    )
);
