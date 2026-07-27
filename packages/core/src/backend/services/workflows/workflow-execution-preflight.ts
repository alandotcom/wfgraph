import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { validateWorkflowActionConfigs } from "@/backend/lib/workflow-action-validation";
import { validateWorkflowConditionConfigs } from "@/backend/lib/workflow-conditions-validation";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import { validateWorkflowIntegrations } from "@/backend/lib/workflow-integration-validation";
import type { ApiErrorPayload } from "@/shared/workflow/api-contracts";
import {
  resolveWorkflowTriggerDefinition,
  type TriggerExecutionType,
  type WorkflowTriggerDefinition,
} from "@/shared/workflow/trigger-registry";
import type {
  SerializedWorkflowGraph,
  WorkflowNode,
} from "@/shared/workflow/types";

type PreflightLogger = {
  error: (message: string, properties?: Record<string, unknown>) => void;
};

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

export async function runWorkflowExecutionPreflight(input: {
  workflow: WorkflowForPreflight;
  logger: PreflightLogger;
  requireExecutionType?: TriggerExecutionType;
}): Promise<
  ServiceResult<WorkflowExecutionPreflight, "invalid", ApiErrorPayload>
> {
  const { workflow, logger, requireExecutionType } = input;

  const graphValidation = validateWorkflowGraph(workflow.graph);
  if (!graphValidation.valid) {
    logger.error("Invalid workflow graph", {
      workflowName: workflow.name,
      error: graphValidation.error,
    });
    return failure("invalid", { error: "Workflow graph is invalid" });
  }

  const actionValidation = validateWorkflowActionConfigs(graphValidation.nodes);
  if (!actionValidation.valid) {
    logger.error("Invalid workflow action configuration", {
      workflowName: workflow.name,
      error: actionValidation.error,
    });
    return failure("invalid", { error: actionValidation.error });
  }

  const conditionValidation = validateWorkflowConditionConfigs(
    graphValidation.nodes
  );
  if (!conditionValidation.valid) {
    logger.error("Invalid workflow condition configuration", {
      workflowName: workflow.name,
      error: conditionValidation.error,
    });
    return failure("invalid", { error: conditionValidation.error });
  }

  const integrationValidation = await validateWorkflowIntegrations(
    graphValidation.nodes
  );
  if (!integrationValidation.valid) {
    logger.error("Invalid integration references in workflow", {
      workflowName: workflow.name,
      invalidIntegrationIds: integrationValidation.invalidIds,
    });
    return failure("invalid", {
      error: "Workflow contains invalid integration references",
      code: "integration_validation_failed",
      invalidIntegrationIds: integrationValidation.invalidIds ?? [],
    });
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
    return failure("invalid", {
      error: `This workflow is not configured for ${requireExecutionType} triggers`,
    });
  }

  return success({
    workflowGraph: graphValidation.graph,
    workflowNodes: graphValidation.nodes,
    triggerNode,
    triggerConfig,
    triggerDefinition,
  });
}
