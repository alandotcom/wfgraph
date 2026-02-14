import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { validateWorkflowIntegrations } from "@/backend/lib/db/integrations";
import { workflows } from "@/backend/lib/db/schema";
import { invalidateInngestFunctionsCache } from "@/backend/lib/inngest/functions";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { validateWorkflowGraph } from "@/backend/lib/workflow-graph";
import type {
  ApiErrorPayload,
  WorkflowApiPayload,
} from "@/shared/workflow/api-contracts";

const workflowServiceLogger = getAppLogger("workflow", "service");

type GetWorkflowResult = ServiceResult<
  WorkflowApiPayload,
  404 | 500,
  ApiErrorPayload
>;

type PatchWorkflowResult = ServiceResult<
  WorkflowApiPayload,
  400 | 403 | 404 | 409 | 500,
  ApiErrorPayload
>;

type DeleteWorkflowResult = ServiceResult<
  { success: true },
  404 | 500,
  ApiErrorPayload
>;

export async function getWorkflow(
  workflowId: string
): Promise<GetWorkflowResult> {
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return failure(404, { error: "Workflow not found" });
    }

    const payload: WorkflowApiPayload = {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description ?? undefined,
      graph: workflow.graph,
      visibility: "private",
      isOwner: true,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    };

    return success(payload);
  } catch (error) {
    workflowServiceLogger.error("Failed to get workflow", {
      workflowId,
      error,
    });
    return failure(500, {
      error: error instanceof Error ? error.message : "Failed to get workflow",
    });
  }
}

function buildUpdateData(
  body: Record<string, unknown>
): Record<string, unknown> {
  const updateData: Record<string, unknown> = {
    updatedAt: new Date(),
    visibility: "private",
  };

  if (body.name !== undefined) {
    updateData.name = body.name;
  }
  if (body.description !== undefined) {
    updateData.description = body.description;
  }
  if (body.graph !== undefined) {
    updateData.graph = body.graph;
  }
  return updateData;
}

export async function patchWorkflow(
  workflowId: string,
  body: {
    name?: string;
    description?: string;
    graph?: unknown;
  }
): Promise<PatchWorkflowResult> {
  const requestLogger = workflowServiceLogger.with({ workflowId });
  try {
    const existingWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!existingWorkflow) {
      return failure(404, { error: "Workflow not found" });
    }

    if (body.name !== undefined) {
      const normalizedName = body.name.trim();
      if (!normalizedName) {
        requestLogger.warn("Rejected workflow update with empty name");
        return failure(400, { error: "Workflow name is required" });
      }

      const nameConflict = await db.query.workflows.findFirst({
        where: and(
          sql`lower(${workflows.name}) = lower(${normalizedName})`,
          ne(workflows.id, workflowId)
        ),
        columns: { id: true },
      });
      if (nameConflict) {
        requestLogger.warn("Duplicate workflow name on update", {
          workflowName: normalizedName,
        });
        return failure(409, {
          error: `Workflow name "${normalizedName}" already exists`,
        });
      }

      body.name = normalizedName;
    }

    if (body.graph !== undefined) {
      const graphValidation = validateWorkflowGraph(body.graph);
      if (!graphValidation.valid) {
        requestLogger.warn("Rejected invalid workflow graph on update", {
          error: graphValidation.error,
        });
        return failure(400, { error: graphValidation.error });
      }

      const integrationValidation = await validateWorkflowIntegrations(
        graphValidation.nodes
      );
      if (!integrationValidation.valid) {
        requestLogger.warn(
          "Rejected workflow update due to invalid integrations",
          {
            invalidIntegrationIds: integrationValidation.invalidIds,
          }
        );
        return failure(403, {
          error: "Invalid integration references in workflow",
        });
      }

      body.graph = graphValidation.graph;
    }

    const updateData = buildUpdateData(body);

    const [updatedWorkflow] = await db
      .update(workflows)
      .set(updateData)
      .where(eq(workflows.id, workflowId))
      .returning();

    if (!updatedWorkflow) {
      return failure(404, { error: "Workflow not found" });
    }

    invalidateInngestFunctionsCache();

    requestLogger.info("Workflow updated", {
      workflowName: updatedWorkflow.name,
      hasGraph: body.graph !== undefined,
    });

    const payload: WorkflowApiPayload = {
      id: updatedWorkflow.id,
      name: updatedWorkflow.name,
      description: updatedWorkflow.description ?? undefined,
      graph: updatedWorkflow.graph,
      visibility: "private",
      isOwner: true,
      createdAt: updatedWorkflow.createdAt.toISOString(),
      updatedAt: updatedWorkflow.updatedAt.toISOString(),
    };

    return success(payload);
  } catch (error) {
    requestLogger.error("Failed to update workflow", { error });
    return failure(500, {
      error:
        error instanceof Error ? error.message : "Failed to update workflow",
    });
  }
}

export async function deleteWorkflow(
  workflowId: string
): Promise<DeleteWorkflowResult> {
  const requestLogger = workflowServiceLogger.with({ workflowId });
  try {
    const existingWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!existingWorkflow) {
      return failure(404, { error: "Workflow not found" });
    }

    await db.delete(workflows).where(eq(workflows.id, workflowId));
    invalidateInngestFunctionsCache();

    requestLogger.info("Workflow deleted");

    return success({ success: true as const });
  } catch (error) {
    requestLogger.error("Failed to delete workflow", { error });
    return failure(500, {
      error:
        error instanceof Error ? error.message : "Failed to delete workflow",
    });
  }
}
