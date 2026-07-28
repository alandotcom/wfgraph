import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflowExecutions } from "@/backend/lib/db/schema";
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
import { getErrorMessage } from "@rova/shared/utils";

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
  ServiceResult<
    CancelExecutionSuccess,
    "not_found" | "conflict" | "internal",
    CancelExecutionError
  >
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
      return failure("not_found", { error: "Execution not found" });
    }

    const waitingStates = await listExecutionWaitingStates(executionId);

    if (waitingStates.length === 0) {
      requestLogger.warn("Execution is not waiting and cannot be cancelled");
      return failure("conflict", {
        error: "Execution is not currently waiting",
      });
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
      return failure("conflict", { error: "Execution is no longer waiting" });
    }

    const wasInFlight = await markExecutionCancelled({
      executionId,
      error: "Cancelled manually",
    });

    // A policy cancel can flip the row between the wait-state CAS and this
    // write. The run is cancelled either way, so the caller still gets a
    // success; only the duplicate audit attribution is skipped, since the
    // policy's run_cancelled entry already exists.
    if (wasInFlight) {
      await logWorkflowAuditEvent({
        workflowId: execution.workflowId,
        executionId,
        eventType: "run_cancelled",
        message: "Run cancelled manually while waiting",
        metadata: {
          waitingStates: cancelledWaitStateIds.length,
        },
      });
    }

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
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to cancel execution",
    });
  }
}
