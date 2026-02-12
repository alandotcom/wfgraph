import {
  logWorkflowAuditEvent,
  type WorkflowAuditEventType,
} from "@/lib/workflow-audit";

type WorkflowAuditStepInput = {
  workflowId: string;
  executionId?: string | null;
  eventType: WorkflowAuditEventType;
  message: string;
  metadata?: Record<string, unknown>;
};

export async function workflowAuditStep(input: WorkflowAuditStepInput) {
  await logWorkflowAuditEvent(input);
  return { success: true };
}
workflowAuditStep.maxRetries = 0;
