import { db } from "@/lib/db";
import { workflowExecutionEvents } from "@/lib/db/schema";

export type WorkflowAuditEventType =
  | "trigger_received"
  | "run_started"
  | "run_waiting"
  | "run_skipped"
  | "run_resumed"
  | "run_timed_out"
  | "run_cancel_requested"
  | "run_cancelled"
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
