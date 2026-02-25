import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflowExecutions } from "@/backend/lib/db/schema";
import { responseFromServiceResult } from "@/backend/lib/http/response-from-service-result";
import { sendWorkflowCancelRequested } from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import {
  listExecutionWaitingStates,
  markExecutionCancelled,
  markWaitingStatesCancelled,
} from "@/backend/lib/workflow-wait-state";
import { getErrorMessage } from "@/shared/utils";

const executionCancelLogger = getAppLogger("workflow", "execution-cancel");

type CancelExecutionSuccess = {
  success: true;
  status: "cancelled";
  cancelledWaitStates: number;
};

type CancelExecutionError = { error: string };

export async function postExecutionCancelResult(
  executionId: string
): Promise<
  ServiceResult<CancelExecutionSuccess, 404 | 409 | 500, CancelExecutionError>
> {
  const requestLogger = executionCancelLogger.with({ executionId });
  try {
    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      with: {
        workflow: true,
      },
    });

    if (!execution) {
      requestLogger.warn("Execution not found for cancel");
      return failure(404, { error: "Execution not found" });
    }

    const waitingStates = await listExecutionWaitingStates(executionId);

    if (waitingStates.length === 0) {
      requestLogger.warn("Execution is not waiting and cannot be cancelled");
      return failure(409, { error: "Execution is not currently waiting" });
    }

    await logWorkflowAuditEvent({
      workflowId: execution.workflowId,
      executionId,
      eventType: "run_cancel_requested",
      message: "Manual cancellation requested",
    });

    await sendWorkflowCancelRequested({
      executionId,
      workflowId: execution.workflowId,
      reason: "Cancelled manually",
      requestedBy: "manual",
    });

    const cancelledWaitStateIds = await markWaitingStatesCancelled(
      waitingStates.map((state) => state.id)
    );
    if (cancelledWaitStateIds.length === 0) {
      requestLogger.warn(
        "Execution wait state changed before cancel persisted"
      );
      return failure(409, { error: "Execution is no longer waiting" });
    }

    await markExecutionCancelled({
      executionId,
      error: "Cancelled manually",
    });

    await logWorkflowAuditEvent({
      workflowId: execution.workflowId,
      executionId,
      eventType: "run_cancelled",
      message: "Run cancelled manually while waiting",
      metadata: {
        waitingStates: cancelledWaitStateIds.length,
      },
    });

    return success({
      success: true,
      status: "cancelled",
      cancelledWaitStates: cancelledWaitStateIds.length,
    });
  } catch (error) {
    requestLogger.error(
      `Failed to cancel execution: ${getErrorMessage(error)}`,
      { error }
    );
    return failure(500, {
      error:
        error instanceof Error ? error.message : "Failed to cancel execution",
    });
  }
}

export async function postExecutionCancel(executionId: string) {
  return responseFromServiceResult(
    await postExecutionCancelResult(executionId)
  );
}
