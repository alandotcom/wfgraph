import type { WorkflowVersion } from "#src/backend/lib/db/schema";

/** A current or actively pinned version, including the graph inspected for usage. */
type WorkflowVersionUsageFields = Pick<
  WorkflowVersion,
  "id" | "graph" | "catalogFingerprint" | "publishedAt"
> & {
  isCurrent: boolean;
  activeRunCount: number;
  oldestActiveRunAt: Date | null;
};

export type WorkflowVersionUsageRow = WorkflowVersionUsageFields &
  (
    | { kind: "published"; version: number }
    | { kind: "draft_snapshot"; version: null }
  );

/** Enforces the version-kind invariant at the persistence boundary. */
export function workflowVersionUsageRow(
  row: WorkflowVersionUsageFields & Pick<WorkflowVersion, "kind" | "version">
): WorkflowVersionUsageRow {
  if (row.kind === "published" && row.version !== null) {
    return { ...row, kind: row.kind, version: row.version };
  }
  if (row.kind === "draft_snapshot" && row.version === null) {
    return { ...row, kind: row.kind, version: row.version };
  }
  throw new Error("Workflow version kind and number disagree");
}
