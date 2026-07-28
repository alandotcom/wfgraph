import { Effect } from "effect";
import type { EffectLogger } from "#src/backend/lib/effect/app-logger";
import { callDbModule } from "#src/backend/lib/effect/database";
import {
  IntegrationValidationFailed,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { validateWorkflowActionConfigs } from "#src/backend/lib/workflow-action-validation";
import { validateWorkflowConditionConfigs } from "#src/backend/lib/workflow-conditions-validation";
import { validateWorkflowGraph } from "#src/backend/lib/workflow-graph";
import { validateWorkflowIntegrations } from "#src/backend/lib/workflow-integration-validation";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import {
  resolveWorkflowTriggerDefinition,
  type TriggerExecutionType,
  type WorkflowTriggerDefinition,
} from "@rova/shared/workflow/trigger-registry";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@rova/shared/workflow/types";

type WorkflowForPreflight = {
  name: string;
  graph: unknown;
};

export type WorkflowExecutionPreflight = {
  workflowGraph: SerializedWorkflowGraph;
  workflowNodes: WorkflowNode[];
  triggerNode: WorkflowNode | undefined;
  triggerConfig: Record<string, unknown> | undefined;
  triggerDefinition: WorkflowTriggerDefinition;
};

/**
 * Everything that has to hold before a stored graph is allowed to run: it
 * parses, its actions and conditions are configured, the integrations it names
 * exist, and its trigger is the kind the entrypoint asking can drive.
 *
 * The logger arrives from the caller rather than from `AppLogger` here, because
 * these lines belong to the entrypoint's category and carry the ids it bound.
 */
export const runWorkflowExecutionPreflight = Effect.fn(
  "runWorkflowExecutionPreflight"
)(function* (input: {
  workflow: WorkflowForPreflight;
  logger: EffectLogger;
  requireExecutionType?: TriggerExecutionType;
}) {
  const { workflow, logger, requireExecutionType } = input;

  const graphValidation = validateWorkflowGraph(workflow.graph);
  if (!graphValidation.valid) {
    yield* logger.error("Invalid workflow graph", {
      workflowName: workflow.name,
      error: graphValidation.error,
    });
    return yield* Effect.fail(
      new InvalidInput({ error: "Workflow graph is invalid" })
    );
  }

  const actionValidation = validateWorkflowActionConfigs(graphValidation.nodes);
  if (!actionValidation.valid) {
    yield* logger.error("Invalid workflow action configuration", {
      workflowName: workflow.name,
      error: actionValidation.error,
    });
    return yield* Effect.fail(
      new InvalidInput({ error: actionValidation.error })
    );
  }

  const conditionValidation = validateWorkflowConditionConfigs(
    graphValidation.nodes
  );
  if (!conditionValidation.valid) {
    yield* logger.error("Invalid workflow condition configuration", {
      workflowName: workflow.name,
      error: conditionValidation.error,
    });
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
    yield* logger.error("Invalid integration references in workflow", {
      workflowName: workflow.name,
      invalidIntegrationIds: integrationValidation.invalidIds,
    });
    return yield* Effect.fail(
      new IntegrationValidationFailed({
        error: "Workflow contains invalid integration references",
        invalidIntegrationIds: integrationValidation.invalidIds ?? [],
      })
    );
  }

  const triggerNode = graphValidation.nodes.find(
    (node) => node.data.type === "trigger"
  );
  const triggerConfig = triggerNode?.data.config;
  const triggerDefinition = resolveWorkflowTriggerDefinition(triggerConfig);

  if (
    requireExecutionType &&
    (!triggerNode ||
      triggerDefinition.runtime.executionType !== requireExecutionType)
  ) {
    return yield* Effect.fail(
      new InvalidInput({
        error: `This workflow is not configured for ${requireExecutionType} triggers`,
      })
    );
  }

  const preflight: WorkflowExecutionPreflight = {
    workflowGraph: graphValidation.graph,
    workflowNodes: graphValidation.nodes,
    triggerNode,
    triggerConfig,
    triggerDefinition,
  };
  return preflight;
});

/**
 * The prelude the two HTTP entrypoints share: find the workflow the request
 * names, then check that it may run. Either step's refusal is the answer the
 * caller gets, so neither is handled here.
 *
 * The event listener runs the same two steps itself rather than through this,
 * because it turns both refusals into a return value for Inngest and names the
 * workflow in the line it writes about the second one.
 */
export const loadWorkflowForRun = Effect.fn("loadWorkflowForRun")(
  function* (input: {
    workflowId: string;
    logger: EffectLogger;
    requireExecutionType?: TriggerExecutionType;
  }) {
    const repo = yield* WorkflowRepo;
    const workflow = yield* repo.findById(input.workflowId);

    if (!workflow) {
      return yield* Effect.fail(new NotFound({ error: "Workflow not found" }));
    }

    const preflight = yield* runWorkflowExecutionPreflight({
      workflow,
      logger: input.logger,
      requireExecutionType: input.requireExecutionType,
    });

    return { workflow, preflight };
  }
);
