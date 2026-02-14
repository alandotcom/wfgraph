import { sendWorkflowCancelRequested } from "@/backend/lib/inngest/runtime-events";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import {
  markExecutionCancelled,
  markWaitingStatesCancelled,
} from "@/backend/lib/workflow-wait-state";

type CancellationLogger = {
  error: (message: string, properties?: Record<string, unknown>) => void;
};

export type CancelWaitingRunsInput = {
  workflowId: string;
  waitStates: Array<{
    id: string;
    executionId: string;
  }>;
  reason: string;
  eventType?: string;
  logger: CancellationLogger;
};

export type CancelWaitingRunsSummary = {
  cancelledExecutions: number;
  cancelledWaits: number;
};

export async function cancelWaitingRuns(
  input: CancelWaitingRunsInput
): Promise<CancelWaitingRunsSummary> {
  const uniqueExecutionIds = Array.from(
    new Set(input.waitStates.map((waitState) => waitState.executionId))
  );

  for (const executionId of uniqueExecutionIds) {
    try {
      await sendWorkflowCancelRequested({
        executionId,
        workflowId: input.workflowId,
        reason: input.reason,
        requestedBy: input.workflowId,
        eventType: input.eventType,
      });
    } catch (error) {
      input.logger.error("Failed to send cancel signal for execution", {
        workflowId: input.workflowId,
        executionId,
        eventType: input.eventType,
        error,
      });
    }
  }

  await markWaitingStatesCancelled(input.waitStates.map((state) => state.id));

  for (const executionId of uniqueExecutionIds) {
    await markExecutionCancelled({
      executionId,
      error: input.reason,
    });

    await logWorkflowAuditEvent({
      workflowId: input.workflowId,
      executionId,
      eventType: "run_cancelled",
      message: input.reason,
      metadata: {
        eventType: input.eventType,
      },
    });
  }

  return {
    cancelledExecutions: uniqueExecutionIds.length,
    cancelledWaits: input.waitStates.length,
  };
}
