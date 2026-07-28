import type { Workflow } from "#src/backend/lib/db/schema";
import type { WorkflowApiPayload } from "@rova/shared/workflow/api-contracts";
import type { SerializedWorkflowGraph } from "@rova/shared/workflow/types";

type WorkflowPayloadSource = Pick<
  Workflow,
  | "id"
  | "name"
  | "description"
  | "graph"
  | "isPaused"
  | "mode"
  | "visibility"
  | "createdAt"
  | "updatedAt"
>;

type WorkflowUpdateInput = {
  name?: string;
  description?: string;
  graph?: SerializedWorkflowGraph;
  mode?: "live" | "test";
};

/**
 * The columns an update writes: the fields the caller asked to change, plus the
 * timestamp every write touches. Named so the repository can take one without
 * restating the shape.
 */
export type WorkflowUpdateData = Pick<Workflow, "updatedAt"> &
  Partial<Pick<Workflow, "name" | "description" | "graph" | "mode">>;

export function toWorkflowApiPayload(
  workflow: WorkflowPayloadSource
): WorkflowApiPayload {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? undefined,
    graph: workflow.graph,
    isPaused: workflow.isPaused,
    mode: workflow.mode,
    visibility: workflow.visibility,
    isOwner: true,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

export function buildWorkflowUpdateData(
  body: WorkflowUpdateInput,
  updatedAt: Date = new Date()
): WorkflowUpdateData {
  const updateData: WorkflowUpdateData = {
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
  if (body.mode !== undefined) {
    updateData.mode = body.mode;
  }

  return updateData;
}
