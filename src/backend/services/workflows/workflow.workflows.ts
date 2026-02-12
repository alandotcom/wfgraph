import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { validateWorkflowIntegrations } from "@/backend/lib/db/integrations";
import { workflows } from "@/backend/lib/db/schema";
import { invalidateInngestFunctionsCache } from "@/backend/lib/inngest/functions";
import { getAppLogger } from "@/backend/lib/logger";
import type { WorkflowNode } from "@/shared/workflow/types";

const workflowServiceLogger = getAppLogger("workflow", "service");

export async function getWorkflow(workflowId: string) {
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return Response.json({ error: "Workflow not found" }, { status: 404 });
    }

    return Response.json({
      ...workflow,
      nodes: workflow.nodes,
      visibility: "private",
      isOwner: true,
      createdAt: workflow.createdAt.toISOString(),
      updatedAt: workflow.updatedAt.toISOString(),
    });
  } catch (error) {
    workflowServiceLogger.error("Failed to get workflow", {
      workflowId,
      error,
    });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get workflow",
      },
      { status: 500 }
    );
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
  if (body.nodes !== undefined) {
    updateData.nodes = body.nodes;
  }
  if (body.edges !== undefined) {
    updateData.edges = body.edges;
  }
  return updateData;
}

export async function patchWorkflow(
  workflowId: string,
  body: {
    name?: string;
    description?: string;
    nodes?: unknown[];
    edges?: unknown[];
  }
) {
  const requestLogger = workflowServiceLogger.with({ workflowId });
  try {
    const existingWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!existingWorkflow) {
      return Response.json({ error: "Workflow not found" }, { status: 404 });
    }

    if (body.name !== undefined) {
      const normalizedName = body.name.trim();
      if (!normalizedName) {
        requestLogger.warn("Rejected workflow update with empty name");
        return Response.json(
          { error: "Workflow name is required" },
          { status: 400 }
        );
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
        return Response.json(
          { error: `Workflow name "${normalizedName}" already exists` },
          { status: 409 }
        );
      }

      body.name = normalizedName;
    }

    if (Array.isArray(body.nodes)) {
      const validation = await validateWorkflowIntegrations(
        body.nodes as WorkflowNode[]
      );
      if (!validation.valid) {
        requestLogger.warn(
          "Rejected workflow update due to invalid integrations",
          {
            invalidIntegrationIds: validation.invalidIds,
          }
        );
        return Response.json(
          { error: "Invalid integration references in workflow" },
          { status: 403 }
        );
      }
    }

    const updateData = buildUpdateData(body);

    const [updatedWorkflow] = await db
      .update(workflows)
      .set(updateData)
      .where(eq(workflows.id, workflowId))
      .returning();

    if (!updatedWorkflow) {
      return Response.json({ error: "Workflow not found" }, { status: 404 });
    }

    invalidateInngestFunctionsCache();

    requestLogger.info("Workflow updated", {
      workflowName: updatedWorkflow.name,
      hasNodes: Array.isArray(body.nodes),
      hasEdges: Array.isArray(body.edges),
    });

    return Response.json({
      ...updatedWorkflow,
      visibility: "private",
      isOwner: true,
      createdAt: updatedWorkflow.createdAt.toISOString(),
      updatedAt: updatedWorkflow.updatedAt.toISOString(),
    });
  } catch (error) {
    requestLogger.error("Failed to update workflow", { error });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to update workflow",
      },
      { status: 500 }
    );
  }
}

export async function deleteWorkflow(workflowId: string) {
  const requestLogger = workflowServiceLogger.with({ workflowId });
  try {
    const existingWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!existingWorkflow) {
      return Response.json({ error: "Workflow not found" }, { status: 404 });
    }

    await db.delete(workflows).where(eq(workflows.id, workflowId));
    invalidateInngestFunctionsCache();

    requestLogger.info("Workflow deleted");

    return Response.json({ success: true });
  } catch (error) {
    requestLogger.error("Failed to delete workflow", { error });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to delete workflow",
      },
      { status: 500 }
    );
  }
}
