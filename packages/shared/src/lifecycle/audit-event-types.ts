/**
 * The audit event types, as the two scopes they divide into.
 *
 * The rows themselves are written and read through `ExecutionRepo`; this module
 * is the vocabulary both halves are held to. It lives in shared so the Drizzle
 * schema can name the workflow-scoped literals in an index predicate without
 * importing through `#src/` (drizzle-kit's schema loader cannot resolve that
 * subpath).
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
 * The audit rows that belong to the workflow, because no run was opened or
 * reached.
 *
 * `run_refused` is first-wins Concurrency finding a run for the entity already
 * going, a payload carrying nothing at the Correlation Path Concurrency needs,
 * a manual start a workflow's own rules do not allow, or an arrival the Start
 * Event's Start Filter declined. The Refused Starts reader displays these rows.
 * `cancel_not_delivered` records a Cancel Event with a missing Entity Value or
 * a declined or unevaluable Cancel Filter. The Cancellation Failures reader
 * displays those rows. Each reader gets its own latest rows. A decision with no
 * row is the class of invisible behaviour ADR-0007 exists to remove, and neither
 * event type has an Execution to hang on.
 */
export const WORKFLOW_SCOPED_AUDIT_EVENT_TYPES = [
  "run_refused",
  "cancel_not_delivered",
] as const;

export type RunScopedAuditEventType =
  (typeof RUN_SCOPED_AUDIT_EVENT_TYPES)[number];

export type WorkflowScopedAuditEventType =
  (typeof WORKFLOW_SCOPED_AUDIT_EVENT_TYPES)[number];
