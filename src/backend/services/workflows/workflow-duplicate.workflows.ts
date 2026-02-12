import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { workflows } from "@/lib/db/schema";
import { invalidateInngestFunctionsCache } from "@/lib/inngest/functions";
import { getAppLogger } from "@/lib/logger";
import { generateId } from "@/lib/utils/id";

type WorkflowNodeLike = {
  id: string;
  data?: {
    config?: {
      integrationId?: string;
      [key: string]: unknown;
    };
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function stripIntegrationIds(nodes: WorkflowNodeLike[]): WorkflowNodeLike[] {
  return nodes.map((node) => {
    const newNode: WorkflowNodeLike = { ...node, id: nanoid() };
    if (newNode.data) {
      const data = { ...newNode.data };
      if (data.config) {
        const configWithoutIntegration = { ...data.config };
        configWithoutIntegration.integrationId = undefined;
        data.config = configWithoutIntegration;
      }
      data.status = "idle";
      newNode.data = data;
    }
    return newNode;
  });
}

type WorkflowEdgeLike = {
  id: string;
  source: string;
  target: string;
  [key: string]: unknown;
};

function updateEdgeReferences(
  edges: WorkflowEdgeLike[],
  oldNodes: WorkflowNodeLike[],
  newNodes: WorkflowNodeLike[]
): WorkflowEdgeLike[] {
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

const workflowDuplicateLogger = getAppLogger("workflow", "duplicate");

export async function postWorkflowDuplicate(workflowId: string) {
  const requestLogger = workflowDuplicateLogger.with({ workflowId });
  try {
    const sourceWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!sourceWorkflow) {
      return Response.json({ error: "Workflow not found" }, { status: 404 });
    }

    const oldNodes = sourceWorkflow.nodes as WorkflowNodeLike[];
    const newNodes = stripIntegrationIds(oldNodes);
    const newEdges = updateEdgeReferences(
      sourceWorkflow.edges as WorkflowEdgeLike[],
      oldNodes,
      newNodes
    );

    const baseName = `${sourceWorkflow.name} (Copy)`;
    const workflowName = baseName;
    const existingWorkflow = await db.query.workflows.findFirst({
      where: sql`lower(${workflows.name}) = lower(${workflowName})`,
      columns: { id: true },
    });
    if (existingWorkflow) {
      requestLogger.warn("Duplicate workflow name on duplicate", {
        workflowName,
      });
      return Response.json(
        { error: `Workflow name "${workflowName}" already exists` },
        { status: 409 }
      );
    }

    const newWorkflowId = generateId();
    const [newWorkflow] = await db
      .insert(workflows)
      .values({
        id: newWorkflowId,
        name: workflowName,
        description: sourceWorkflow.description,
        nodes: newNodes,
        edges: newEdges,
        visibility: "private",
      })
      .returning();

    invalidateInngestFunctionsCache();

    requestLogger.info("Workflow duplicated", {
      sourceWorkflowName: sourceWorkflow.name,
      workflowName,
      newWorkflowId,
    });

    return Response.json({
      ...newWorkflow,
      isOwner: true,
      createdAt: newWorkflow.createdAt.toISOString(),
      updatedAt: newWorkflow.updatedAt.toISOString(),
    });
  } catch (error) {
    requestLogger.error("Failed to duplicate workflow", { error });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to duplicate workflow",
      },
      { status: 500 }
    );
  }
}
