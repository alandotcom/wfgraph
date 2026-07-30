import { db } from "#src/backend/lib/db/index";
import { workflowExecutionEvents } from "#src/backend/lib/db/schema";

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

/**
 * Writes one audit row.
 *
 * The two arms are what keep the scope honest: a run-scoped type has to name its
 * Execution, and a workflow-scoped one has none to name. The reader for each is
 * keyed on that -- the run timeline by execution id, the Refused Starts panel by
 * this list -- so a row written into the wrong arm would be a row nothing shows.
 */
export async function logWorkflowAuditEvent(
  input: {
    workflowId: string;
    message: string;
    metadata?: Record<string, unknown>;
  } & (
    | { eventType: RunScopedAuditEventType; executionId: string }
    | { eventType: WorkflowScopedAuditEventType; executionId?: undefined }
  )
) {
  await db.insert(workflowExecutionEvents).values({
    workflowId: input.workflowId,
    executionId: input.executionId ?? null,
    eventType: input.eventType,
    message: input.message,
    metadata: input.metadata,
  });
}
