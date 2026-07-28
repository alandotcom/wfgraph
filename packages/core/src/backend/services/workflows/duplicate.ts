import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "#src/backend/lib/db/index";
import { workflows } from "#src/backend/lib/db/schema";
import { invalidateInngestFunctionsCache } from "#src/backend/lib/inngest/functions";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "#src/backend/lib/service-result";
import { toWorkflowApiPayload } from "#src/backend/services/workflows/mappers";
import { getErrorMessage } from "@rova/shared/utils";
import { generateId } from "@rova/shared/utils/id";
import type {
  ApiErrorPayload,
  WorkflowApiPayload,
} from "@rova/shared/workflow/api-contracts";
import {
  createSerializedWorkflowGraph,
  toWorkflowGraphData,
} from "@rova/shared/workflow/graph";
import type { WorkflowEdge, WorkflowNode } from "@rova/shared/workflow/types";

function stripIntegrationIds(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.map((node) => {
    const newNode: WorkflowNode = { ...node, id: nanoid() };
    const currentData = newNode.data;
    if (currentData) {
      const updatedData = { ...currentData };
      if (updatedData.config) {
        updatedData.config = {
          ...updatedData.config,
          integrationId: undefined,
        };
      }
      updatedData.status = "idle";
      newNode.data = updatedData;
    }
    return newNode;
  });
}

function updateEdgeReferences(
  edges: WorkflowEdge[],
  oldNodes: WorkflowNode[],
  newNodes: WorkflowNode[]
): WorkflowEdge[] {
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

type DuplicateWorkflowResult = ServiceResult<
  WorkflowApiPayload,
  "not_found" | "conflict" | "internal",
  ApiErrorPayload
>;

export async function postWorkflowDuplicate(
  workflowId: string
): Promise<DuplicateWorkflowResult> {
  const requestLogger = workflowDuplicateLogger.with({ workflowId });
  try {
    const sourceWorkflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!sourceWorkflow) {
      return failure("not_found", { error: "Workflow not found" });
    }

    const sourceGraph = sourceWorkflow.graph;
    const { nodes: oldNodes, edges: oldEdges } =
      toWorkflowGraphData(sourceGraph);
    const newNodes = stripIntegrationIds(oldNodes);
    const newEdges = updateEdgeReferences(oldEdges, oldNodes, newNodes);
    const newGraph = createSerializedWorkflowGraph({
      nodes: newNodes,
      edges: newEdges,
      attributes: sourceGraph.attributes,
    });

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
      return failure("conflict", {
        error: `Workflow name "${workflowName}" already exists`,
      });
    }

    const newWorkflowId = generateId();
    const [newWorkflow] = await db
      .insert(workflows)
      .values({
        id: newWorkflowId,
        name: workflowName,
        description: sourceWorkflow.description,
        graph: newGraph,
        mode: sourceWorkflow.mode,
        visibility: "private",
      })
      .returning();

    invalidateInngestFunctionsCache();

    requestLogger.info("Workflow duplicated", {
      sourceWorkflowName: sourceWorkflow.name,
      workflowName,
      newWorkflowId,
    });

    return success(toWorkflowApiPayload(newWorkflow));
  } catch (error) {
    requestLogger.error(
      `Failed to duplicate workflow: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to duplicate workflow",
    });
  }
}
