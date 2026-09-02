import { isNotNil } from "es-toolkit/predicate";
import { nanoid } from "nanoid";
import type {
  PublishedWorkflowVersion,
  Workflow,
} from "#src/backend/lib/db/schema";
import type {
  WorkflowApiPayload,
  WorkflowSummaryPayload,
} from "@wfgraph/shared/graph/api-contracts";
import {
  createSerializedWorkflowGraph,
  isSerializedWorkflowGraph,
} from "@wfgraph/shared/graph/graph";
import type { SerializedWorkflowGraph } from "@wfgraph/shared/graph/types";
import { draftDiffersFromPublished } from "#src/backend/services/workflows/version-digest";

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
  | "publishedVersionId"
>;

type WorkflowUpdateInput = {
  name?: string | undefined;
  description?: string | undefined;
  graph?: SerializedWorkflowGraph | undefined;
  mode?: "live" | "test" | undefined;
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
    // `description` is declared with `optionalKey` on the wire, so a workflow
    // with none leaves the key out rather than sending it as null.
    ...(isNotNil(workflow.description)
      ? { description: workflow.description }
      : {}),
    isPaused: workflow.isPaused,
    mode: workflow.mode,
    visibility: workflow.visibility,
    createdAt: workflow.createdAt.toISOString(),
    updatedAt: workflow.updatedAt.toISOString(),
    ...(workflow.publishedVersionId
      ? { publishedVersionId: workflow.publishedVersionId }
      : {}),
  };
}

/**
 * Full workflow payload. Pass the published version (or null when none) so the
 * publish badge can tell draft from live; omitting it is not allowed because a
 * forgotten lookup would report "Published" for a dirty draft.
 */
export function toWorkflowApiPayload(
  workflow: WorkflowPayloadSource,
  published: Pick<
    PublishedWorkflowVersion,
    "id" | "version" | "publishedAt" | "graph" | "graphDigest"
  > | null
): WorkflowApiPayload {
  return {
    ...toWorkflowSummaryPayload(workflow),
    ...(published
      ? {
          publishedVersion: published.version,
          publishedAt: published.publishedAt.toISOString(),
        }
      : {}),
    graph: workflow.graph,
    hasUnpublishedChanges: draftDiffersFromPublished(
      workflow.graph,
      published?.graph ?? null
    ),
  };
}

/**
 * Give an empty graph the Lifecycle Node every workflow needs to be runnable.
 *
 * Both ways a workflow is written for the first time go through here: the
 * create endpoint and the editor's autosave. A graph with nodes is handed back
 * untouched, and so is anything that is not a graph at all, because deciding
 * that is validation's job and it runs next.
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
