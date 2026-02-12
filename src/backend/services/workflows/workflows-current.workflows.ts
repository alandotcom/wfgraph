import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { invalidateInngestFunctionsCache } from "@/lib/inngest/functions";
import { getAppLogger } from "@/lib/logger";
import { generateId } from "@/lib/utils/id";
import { CURRENT_WORKFLOW_NAME } from "@/lib/workflow-constants";

const workflowsCurrentLogger = getAppLogger("workflow", "current");

export async function getWorkflowsCurrent() {
  try {
    const [currentWorkflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.name, CURRENT_WORKFLOW_NAME))
      .orderBy(desc(workflows.updatedAt))
      .limit(1);

    if (!currentWorkflow) {
      return Response.json({ nodes: [], edges: [] });
    }

    return Response.json({
      id: currentWorkflow.id,
      nodes: currentWorkflow.nodes,
      edges: currentWorkflow.edges,
    });
  } catch (error) {
    workflowsCurrentLogger.error("Failed to get current workflow", { error });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get current workflow",
      },
      { status: 500 }
    );
  }
}

export async function postWorkflowsCurrent(body: {
  nodes: unknown[];
  edges: unknown[];
}) {
  try {
    const { nodes, edges } = body;

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
          nodes,
          edges,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, existingWorkflow.id))
        .returning();

      return Response.json({
        id: updatedWorkflow.id,
        nodes: updatedWorkflow.nodes,
        edges: updatedWorkflow.edges,
      });
    }

    const workflowId = generateId();

    const [savedWorkflow] = await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: CURRENT_WORKFLOW_NAME,
        description: "Auto-saved current workflow",
        nodes,
        edges,
      })
      .returning();

    invalidateInngestFunctionsCache();

    return Response.json({
      id: savedWorkflow.id,
      nodes: savedWorkflow.nodes,
      edges: savedWorkflow.edges,
    });
  } catch (error) {
    workflowsCurrentLogger.error("Failed to save current workflow", { error });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to save current workflow",
      },
      { status: 500 }
    );
  }
}
