import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/backend/lib/db";
import { workflows } from "@/backend/lib/db/schema";
import { invalidateInngestFunctionsCache } from "@/backend/lib/inngest/functions";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { validateWorkflowConditionConfigs } from "@/backend/lib/workflow-conditions-validation";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import { validateWorkflowIntegrations } from "@/backend/lib/workflow-integration-validation";
import { toWorkflowApiPayload } from "@/backend/services/workflows/workflow-mappers";
import { getErrorMessage } from "@/shared/utils";
import { generateId } from "@/shared/utils/id";
import type {
  ApiErrorPayload,
  WorkflowApiPayload,
} from "@/shared/workflow/api-contracts";
import {
  createSerializedWorkflowGraph,
  isSerializedWorkflowGraph,
} from "@/shared/workflow/graph";

function createDefaultTriggerNode() {
  return {
    id: nanoid(),
    type: "trigger" as const,
    position: { x: 0, y: 0 },
    data: {
      label: "",
      description: "",
      type: "trigger" as const,
      config: { triggerType: "Webhook" },
      status: "idle" as const,
    },
  };
}

const workflowCreateLogger = getAppLogger("workflow", "create");

type CreateWorkflowResult = ServiceResult<
  WorkflowApiPayload,
  "invalid" | "conflict" | "internal",
  ApiErrorPayload
>;

export async function postWorkflowsCreate(body: {
  name: string;
  description?: string;
  graph: unknown;
}): Promise<CreateWorkflowResult> {
  try {
    const workflowName = body.name.trim();
    if (!workflowName) {
      workflowCreateLogger.warn(
        "Rejected workflow create request with empty name"
      );
      return failure("invalid", { error: "Workflow name is required" });
    }

    const existingWorkflow = await db.query.workflows.findFirst({
      where: sql`lower(${workflows.name}) = lower(${workflowName})`,
      columns: { id: true },
    });
    if (existingWorkflow) {
      workflowCreateLogger.warn("Duplicate workflow name on create", {
        workflowName,
      });
      return failure("conflict", {
        error: `Workflow name "${workflowName}" already exists`,
      });
    }

    const graphWithDefaultTrigger =
      isSerializedWorkflowGraph(body.graph) && body.graph.nodes.length === 0
        ? createSerializedWorkflowGraph({
            nodes: [createDefaultTriggerNode()],
            edges: [],
          })
        : body.graph;

    const graphValidation = validateWorkflowGraph(graphWithDefaultTrigger);
    if (!graphValidation.valid) {
      workflowCreateLogger.warn("Rejected invalid workflow graph on create", {
        workflowName,
        error: graphValidation.error,
      });
      return failure("invalid", { error: graphValidation.error });
    }

    const conditionValidation = validateWorkflowConditionConfigs(
      graphValidation.nodes
    );
    if (!conditionValidation.valid) {
      workflowCreateLogger.warn(
        "Rejected workflow create due to invalid condition configuration",
        {
          workflowName,
          error: conditionValidation.error,
        }
      );
      return failure("invalid", { error: conditionValidation.error });
    }

    const integrationValidation = await validateWorkflowIntegrations(
      graphValidation.nodes
    );
    if (!integrationValidation.valid) {
      workflowCreateLogger.warn(
        "Rejected workflow create due to invalid integrations",
        {
          workflowName,
          invalidIntegrationIds: integrationValidation.invalidIds,
        }
      );
      return failure("invalid", {
        error: "Invalid integration references in workflow",
        code: "integration_validation_failed",
        invalidIntegrationIds: integrationValidation.invalidIds ?? [],
      });
    }

    const workflowId = generateId();

    const [newWorkflow] = await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: workflowName,
        description: body.description,
        graph: graphValidation.graph,
      })
      .returning();

    invalidateInngestFunctionsCache();

    workflowCreateLogger.info("Workflow created", {
      workflowId,
      workflowName,
      nodeCount: graphValidation.nodes.length,
      edgeCount: graphValidation.edges.length,
    });

    return success(toWorkflowApiPayload(newWorkflow));
  } catch (error) {
    workflowCreateLogger.error(
      `Failed to create workflow: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to create workflow",
    });
  }
}
