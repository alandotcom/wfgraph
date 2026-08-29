/**
 * What a `workflow_versions` row is.
 *
 * `published` is the immutable graph a Publish minted, numbered and pointed at
 * by `workflows.published_version_id`. `draft_snapshot` is the graph a test-mode
 * draft run pinned itself to: it carries no version number, stays out of the
 * version history, and nothing ever publishes it.
 *
 * It lives in shared, and imports nothing, so the Drizzle schema can name the
 * literals in a check constraint without importing through `#src/` (drizzle-kit's
 * schema loader cannot resolve that subpath).
 */
export const WORKFLOW_VERSION_KINDS = ["published", "draft_snapshot"] as const;

export type WorkflowVersionKind = (typeof WORKFLOW_VERSION_KINDS)[number];
