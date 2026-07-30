import { db } from "#src/backend/lib/db/index";
import { workflowExecutionEvents } from "#src/backend/lib/db/schema";

/**
 * The timeline beside a run, as the runs panel reads it.
 *
 * `run_not_started` is how a refusal becomes visible: first-wins Concurrency
 * declining a start writes one, because a decision with no row is the class of
 * invisible behaviour ADR-0007 exists to remove. `run_superseded` is the same
 * courtesy for the run newest-wins displaced.
 */
export type WorkflowAuditEventType =
  | "trigger_received"
  | "run_started"
  | "run_not_started"
  | "run_waiting"
  | "run_skipped"
  | "run_resumed"
  | "run_timed_out"
  | "run_cancel_requested"
  | "run_cancelled"
  | "run_superseded"
  | "run_completed"
  | "run_failed"
  | "run_ignored";

export async function logWorkflowAuditEvent(input: {
  workflowId: string;
  executionId?: string | null;
  eventType: WorkflowAuditEventType;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(workflowExecutionEvents).values({
    workflowId: input.workflowId,
    executionId: input.executionId ?? null,
    eventType: input.eventType,
    message: input.message,
    metadata: input.metadata,
  });
}
