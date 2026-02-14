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
  failedExecutions?: string[];
};

export async function cancelWaitingRuns(
  input: CancelWaitingRunsInput
): Promise<CancelWaitingRunsSummary> {
  const uniqueExecutionIds = Array.from(
    new Set(input.waitStates.map((waitState) => waitState.executionId))
  );
  const successfulExecutionIds: string[] = [];
  const failedExecutionIds: string[] = [];

  for (const executionId of uniqueExecutionIds) {
    try {
      await sendWorkflowCancelRequested({
        executionId,
        workflowId: input.workflowId,
        reason: input.reason,
        requestedBy: input.workflowId,
        eventType: input.eventType,
      });
      successfulExecutionIds.push(executionId);
    } catch (error) {
      failedExecutionIds.push(executionId);
      input.logger.error("Failed to send cancel signal for execution", {
        workflowId: input.workflowId,
        executionId,
        eventType: input.eventType,
        error,
      });
    }
  }

  const successfulExecutionIdSet = new Set(successfulExecutionIds);
  const waitStateIdsToCancel = input.waitStates
    .filter((state) => successfulExecutionIdSet.has(state.executionId))
    .map((state) => state.id);
  const cancelledWaitStateIds =
    await markWaitingStatesCancelled(waitStateIdsToCancel);

  for (const executionId of successfulExecutionIds) {
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
    cancelledExecutions: successfulExecutionIds.length,
    cancelledWaits: cancelledWaitStateIds.length,
    failedExecutions:
      failedExecutionIds.length > 0 ? failedExecutionIds : undefined,
  };
}
