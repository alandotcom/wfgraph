import type { Workflow } from "@/backend/lib/db/schema";
import type { WorkflowApiPayload } from "@/shared/workflow/api-contracts";
import type { SerializedWorkflowGraph } from "@/shared/workflow/types";

type WorkflowPayloadSource = Pick<
  Workflow,
  | "id"
  | "name"
  | "description"
  | "graph"
  | "visibility"
  | "createdAt"
  | "updatedAt"
>;

type WorkflowUpdateInput = {
  name?: string;
  description?: string;
  graph?: SerializedWorkflowGraph;
};

export function toWorkflowApiPayload(
  workflow: WorkflowPayloadSource
): WorkflowApiPayload {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? undefined,
    graph: workflow.graph,
    visibility: workflow.visibility,
    isOwner: true,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

export function buildWorkflowUpdateData(
  body: WorkflowUpdateInput,
  updatedAt: Date = new Date()
): Pick<Workflow, "updatedAt"> &
  Partial<Pick<Workflow, "name" | "description" | "graph">> {
  const updateData: Pick<Workflow, "updatedAt"> &
    Partial<Pick<Workflow, "name" | "description" | "graph">> = {
    updatedAt,
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
