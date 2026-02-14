import { desc, eq } from "drizzle-orm";
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
import { CURRENT_WORKFLOW_NAME } from "@/backend/lib/workflow-constants";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import { generateId } from "@/shared/utils/id";
import type {
  ApiErrorPayload,
  WorkflowApiPayload,
} from "@/shared/workflow/api-contracts";
import {
  createSerializedWorkflowGraph,
  isSerializedWorkflowGraph,
} from "@/shared/workflow/graph";

const workflowsCurrentLogger = getAppLogger("workflow", "current");

type GetCurrentWorkflowResult = ServiceResult<
  WorkflowApiPayload,
  500,
  ApiErrorPayload
>;

type SaveCurrentWorkflowResult = ServiceResult<
  WorkflowApiPayload,
  400 | 500,
  ApiErrorPayload
>;

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

export async function getWorkflowsCurrent(): Promise<GetCurrentWorkflowResult> {
  try {
    const [currentWorkflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.name, CURRENT_WORKFLOW_NAME))
      .orderBy(desc(workflows.updatedAt))
      .limit(1);

    if (!currentWorkflow) {
      return success({
        graph: createSerializedWorkflowGraph({ nodes: [], edges: [] }),
      });
    }

    return success({
      id: currentWorkflow.id,
      graph: currentWorkflow.graph,
    });
  } catch (error) {
    workflowsCurrentLogger.error("Failed to get current workflow", { error });
    return failure(500, {
      error:
        error instanceof Error
          ? error.message
          : "Failed to get current workflow",
    });
  }
}

export async function postWorkflowsCurrent(body: {
  graph: unknown;
}): Promise<SaveCurrentWorkflowResult> {
  try {
    const graphToValidate =
      isSerializedWorkflowGraph(body.graph) && body.graph.nodes.length === 0
        ? createSerializedWorkflowGraph({
            nodes: [createDefaultTriggerNode()],
            edges: [],
          })
        : body.graph;

    const graphValidation = validateWorkflowGraph(graphToValidate);
    if (!graphValidation.valid) {
      return failure(400, { error: graphValidation.error });
    }

    const [existingWorkflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.name, CURRENT_WORKFLOW_NAME))
      .orderBy(desc(workflows.updatedAt))
      .limit(1);

    if (existingWorkflow) {
      const [updatedWorkflow] = await db
        .update(workflows)
        .set({
          graph: graphValidation.graph,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, existingWorkflow.id))
        .returning();

      return success({
        id: updatedWorkflow.id,
        graph: updatedWorkflow.graph,
      });
    }

    const workflowId = generateId();

    const [savedWorkflow] = await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: CURRENT_WORKFLOW_NAME,
        description: "Auto-saved current workflow",
        graph: graphValidation.graph,
      })
      .returning();

    invalidateInngestFunctionsCache();

    return success({
      id: savedWorkflow.id,
      graph: savedWorkflow.graph,
    });
  } catch (error) {
    workflowsCurrentLogger.error("Failed to save current workflow", { error });
    return failure(500, {
      error:
        error instanceof Error
          ? error.message
          : "Failed to save current workflow",
    });
  }
}
