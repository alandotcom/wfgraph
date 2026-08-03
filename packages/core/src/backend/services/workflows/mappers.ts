import { nanoid } from "nanoid";
import type { Workflow } from "#src/backend/lib/db/schema";
import type {
  WorkflowApiPayload,
  WorkflowSummaryPayload,
} from "@rova/shared/graph/api-contracts";
import {
  createSerializedWorkflowGraph,
  isSerializedWorkflowGraph,
} from "@rova/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@rova/shared/graph/types";

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

export function toWorkflowSummaryPayload(
  workflow: Omit<WorkflowPayloadSource, "graph">
): WorkflowSummaryPayload {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description ?? undefined,
    isPaused: workflow.isPaused,
    mode: workflow.mode,
    visibility: workflow.visibility,
    isOwner: true,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
  };
}

export function toWorkflowApiPayload(
  workflow: WorkflowPayloadSource
): WorkflowApiPayload {
  return { ...toWorkflowSummaryPayload(workflow), graph: workflow.graph };
}

/**
 * Give an empty graph the Lifecycle Node every workflow needs to be runnable.
 *
 * Both ways a workflow is written for the first time go through here: the
 * create endpoint and the editor's autosave. A graph with nodes is handed back
 * untouched, and so is anything that is not a graph at all, since deciding that
 * is validation's job and it runs next.
 */
export function withDefaultLifecycleNode(graph: unknown): unknown {
  if (!isSerializedWorkflowGraph(graph) || graph.nodes.length > 0) {
    return graph;
  }

  return createSerializedWorkflowGraph({
    nodes: [
      {
        id: nanoid(),
        type: "lifecycle",
        position: { x: 0, y: 0 },
        data: {
          label: "",
          description: "",
          type: "lifecycle",
          config: {},
        },
      },
    ],
    edges: [],
  });
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
