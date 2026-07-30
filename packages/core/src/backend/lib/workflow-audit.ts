/**
 * The audit event types, as the two scopes they divide into.
 *
 * The rows themselves are written and read through `ExecutionRepo`; this module
 * is the vocabulary both halves are held to.
 */

/**
 * The audit rows that belong to a run: everything a run does between opening and
 * ending. Each one has an Execution behind it, and the runs panel reads them under
 * the run they name.
 */
export const RUN_SCOPED_AUDIT_EVENT_TYPES = [
  "run_started",
  "run_waiting",
  "run_skipped",
  "run_resumed",
  "run_timed_out",
  "run_cancel_requested",
  "run_cancelled",
  "run_superseded",
  "run_completed",
  "run_failed",
  "run_ignored",
] as const;

/**
 * The audit rows that belong to the workflow, because no run was opened.
 *
 * `run_not_started` is the whole list: a Refused Start, which is first-wins
 * Concurrency finding a run for the entity already going, a payload carrying
 * nothing at the Correlation Path Concurrency needs, or a manual start a
 * workflow's own rules do not allow. A decision with no row is the class of
 * invisible behaviour ADR-0007 exists to remove, and there is no Execution to
 * hang this one on.
 */
export const WORKFLOW_SCOPED_AUDIT_EVENT_TYPES = ["run_not_started"] as const;

export type RunScopedAuditEventType =
  (typeof RUN_SCOPED_AUDIT_EVENT_TYPES)[number];

export type WorkflowScopedAuditEventType =
  (typeof WORKFLOW_SCOPED_AUDIT_EVENT_TYPES)[number];
