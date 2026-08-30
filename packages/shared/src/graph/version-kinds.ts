/**
 * The two kinds of row in `workflow_versions`. A `published` row is the numbered,
 * immutable graph a publish created, pointed at by `workflows.published_version_id`.
 * A `draft_snapshot` row is the graph a test-mode draft run pinned; it has no
 * number and never enters the version history. This file imports nothing, so the
 * Drizzle schema can name the literals in a check constraint without `#src/`.
 */
export const WORKFLOW_VERSION_KINDS = ["published", "draft_snapshot"] as const;

export type WorkflowVersionKind = (typeof WORKFLOW_VERSION_KINDS)[number];
