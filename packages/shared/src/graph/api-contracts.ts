import type {
  SerializedWorkflowGraph,
  WorkflowMode,
  WorkflowVisibility,
} from "#src/graph/types";

/**
 * One workflow without its graph, which is what the list procedure answers with:
 * a stored graph runs to megabytes and neither screen reading the list draws one.
 */
export type WorkflowSummaryPayload = {
  id: string;
  name: string;
  description?: string;
  isPaused: boolean;
  mode: WorkflowMode;
  visibility: WorkflowVisibility;
  createdAt: string;
  updatedAt: string;
  /** Absent on a payload the viewer did not author. */
  isOwner?: boolean;
  /** Absent until the first publish. */
  publishedVersionId?: string;
};

export type WorkflowApiPayload = WorkflowSummaryPayload & {
  graph: SerializedWorkflowGraph;
};

/** What publish answers with: the draft payload plus the version it just pinned. */
export type WorkflowPublishPayload = WorkflowApiPayload & {
  publishedVersionId: string;
  publishedVersion: number;
};
