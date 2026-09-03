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
  /** Absent until the first publish. */
  publishedVersionId?: string;
};

export type WorkflowApiPayload = WorkflowSummaryPayload & {
  graph: SerializedWorkflowGraph;
  /** Monotonic revision used to protect editable draft writes. */
  draftRevision: number;
  /** Numeric form of the current published version. Absent until first publish. */
  publishedVersion?: number;
  /** Publication time of the current version. Absent until first publish. */
  publishedAt?: string;
  /**
   * Whether the draft graph differs from the published version's graph.
   * False when the workflow has never been published.
   */
  hasUnpublishedChanges: boolean;
};

/** What publish answers with: the draft payload plus the version it just pinned. */
export type WorkflowPublishPayload = WorkflowApiPayload & {
  publishedVersionId: string;
  publishedVersion: number;
  publishedAt: string;
};
