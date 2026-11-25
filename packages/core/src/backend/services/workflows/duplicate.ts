import { Effect } from "effect";
import { omit } from "es-toolkit/object";
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
import { mapOrSame } from "@wfgraph/shared/utils/map-or-same";
import { BUILT_IN_ACTION_IDS } from "@wfgraph/shared/actions/built-in-actions";
import {
  compileConditionModel,
  nodeOutputConditionPath,
  parseConditionModel,
  parseNodeOutputConditionPath,
  serializeConditionModel,
} from "@wfgraph/shared/conditions/conditions";
import {
  ACTION_TYPE_CONFIG_KEY,
  readConfigString,
  readConfigTrimmedString,
} from "@wfgraph/shared/graph/node-config";
import {
  formatTemplateToken,
  mapTemplateTokens,
} from "@wfgraph/shared/graph/node-references";
import { createSerializedWorkflowGraph } from "@wfgraph/shared/graph/graph";
import type { WorkflowEdge, WorkflowNode } from "@wfgraph/shared/graph/types";

/**
 * The graph under fresh node and edge ids, with every reference to a node id
 * moved onto the copy: an edge's ends, a member's `parentId`, each
 * `{{@nodeId:...}}` token in a config, and each Condition rule naming a node's
 * output. Connection ids are stripped separately, just before the row is
 * written, so the copy starts unbound.
 */
function withFreshNodeIds(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[]
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  // A Map, because node ids are text the builder or the build agent chose.
  const idMap = new Map(nodes.map((node) => [node.id, generateId()]));
  const freshId = (nodeId: string) => idMap.get(nodeId) ?? nodeId;

  return {
    nodes: nodes.map((node) => {
      const copy: WorkflowNode = {
        ...node,
        id: freshId(node.id),
        data: {
          ...node.data,
          config: node.data.config && remapConfig(node.data.config, idMap),
        },
      };
      if (node.parentId !== undefined) {
        copy.parentId = freshId(node.parentId);
      }
      return copy;
    }),
    edges: edges.map((edge) => ({
      ...edge,
      id: generateId(),
      source: freshId(edge.source),
      target: freshId(edge.target),
    })),
  };
}

/** A node config with each node id it names replaced by that node's copy. */
function remapConfig(
  config: Record<string, unknown>,
  idMap: ReadonlyMap<string, string>
): Record<string, unknown> {
  const remapped = mapTemplateTokens(config, (token) => {
    const nodeId = idMap.get(token.nodeId);
    return nodeId === undefined
      ? undefined
      : formatTemplateToken({
          nodeId,
          nodeLabel: token.nodeLabel,
          fieldPath: token.fieldPath,
        });
  });
  return readConfigString(remapped, ACTION_TYPE_CONFIG_KEY) ===
    BUILT_IN_ACTION_IDS.condition
    ? remapConditionNodeIds(remapped, idMap)
    : remapped;
}

/**
 * A Condition config whose rules read the copied nodes' outputs.
 *
 * A rule stores the node it reads as `$node:<id>.<path>`, and the compiled
 * expression beside the model names the same id. Save refuses a model and an
 * expression that disagree, so the expression is compiled again from the
 * rewritten model. A blank expression marks a Condition still being built and
 * stays blank.
 */
function remapConditionNodeIds(
  config: Record<string, unknown>,
  idMap: ReadonlyMap<string, string>
): Record<string, unknown> {
  const parsed = parseConditionModel(config.conditionModel);
  if (!parsed.valid) {
    return config;
  }

  const groups = mapOrSame(parsed.model.groups, (group) => {
    const conditions = mapOrSame(group.conditions, (rule) => {
      const reference = parseNodeOutputConditionPath(rule.field);
      const nodeId = reference && idMap.get(reference.nodeId);
      const field =
        reference && nodeId
          ? nodeOutputConditionPath(nodeId, reference.fieldPath)
          : null;
      return field === null || field === rule.field ? rule : { ...rule, field };
    });
    return conditions === group.conditions ? group : { ...group, conditions };
  });
  if (groups === parsed.model.groups) {
    return config;
  }

  const model = { ...parsed.model, groups };
  const compiled = compileConditionModel(model);
  return {
    ...config,
    conditionModel: serializeConditionModel(model),
    condition:
      compiled.valid && readConfigTrimmedString(config, "condition")
        ? compiled.expression
        : config.condition,
  };
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
      return yield* new InternalFailure({
        error:
          "This workflow's saved graph cannot be read, so it cannot be copied.",
      });
    }

    const { nodes: newNodes, edges: newEdges } = withFreshNodeIds(
      sourceValidation.nodes,
      sourceValidation.edges
    );
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
        error: `A workflow named "${workflowName}" already exists. Rename it, then duplicate again.`,
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
                    error:
                      "The copy failed the graph check and was not saved. Report this as a bug.",
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
          "Failed to duplicate workflow",
          "The database refused the request, so the workflow was not copied."
        )
      )
    )
);
