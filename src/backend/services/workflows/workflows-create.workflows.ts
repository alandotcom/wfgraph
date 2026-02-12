import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/backend/lib/db";
import { validateWorkflowIntegrations } from "@/backend/lib/db/integrations";
import { workflows } from "@/backend/lib/db/schema";
import { invalidateInngestFunctionsCache } from "@/backend/lib/inngest/functions";
import { getAppLogger } from "@/backend/lib/logger";
import { generateId } from "@/shared/utils/id";
import type { WorkflowNode } from "@/shared/workflow/types";

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

export async function postWorkflowsCreate(body: {
  name: string;
  description?: string;
  nodes: unknown[];
  edges: unknown[];
}) {
  try {
    const workflowName = body.name.trim();
    if (!workflowName) {
      workflowCreateLogger.warn(
        "Rejected workflow create request with empty name"
      );
      return Response.json(
        { error: "Workflow name is required" },
        { status: 400 }
      );
    }

    const existingWorkflow = await db.query.workflows.findFirst({
      where: sql`lower(${workflows.name}) = lower(${workflowName})`,
      columns: { id: true },
    });
    if (existingWorkflow) {
      workflowCreateLogger.warn("Duplicate workflow name on create", {
        workflowName,
      });
      return Response.json(
        { error: `Workflow name "${workflowName}" already exists` },
        { status: 409 }
      );
    }

    const validation = await validateWorkflowIntegrations(
      body.nodes as WorkflowNode[]
    );
    if (!validation.valid) {
      workflowCreateLogger.warn(
        "Rejected workflow create due to invalid integrations",
        {
          workflowName,
          invalidIntegrationIds: validation.invalidIds,
        }
      );
      return Response.json(
        { error: "Invalid integration references in workflow" },
        { status: 403 }
      );
    }

    let nodes = body.nodes;
    if (nodes.length === 0) {
      nodes = [createDefaultTriggerNode()];
    }

    const workflowId = generateId();

    const [newWorkflow] = await db
      .insert(workflows)
      .values({
        id: workflowId,
        name: workflowName,
        description: body.description,
        nodes,
        edges: body.edges,
      })
      .returning();

    invalidateInngestFunctionsCache();

    workflowCreateLogger.info("Workflow created", {
      workflowId,
      workflowName,
      nodeCount: nodes.length,
      edgeCount: body.edges.length,
    });

    return Response.json({
      ...newWorkflow,
      isOwner: true,
      createdAt: newWorkflow.createdAt.toISOString(),
      updatedAt: newWorkflow.updatedAt.toISOString(),
    });
  } catch (error) {
    workflowCreateLogger.error("Failed to create workflow", { error });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create workflow",
      },
      { status: 500 }
    );
  }
}
