import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflowExecutions } from "@/backend/lib/db/schema";
import { sendWorkflowCancelRequested } from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import {
  listExecutionWaitingStates,
  markExecutionCancelled,
  markWaitingStatesCancelled,
} from "@/backend/lib/workflow-wait-state";

const executionCancelLogger = getAppLogger("workflow", "execution-cancel");

export async function postExecutionCancel(executionId: string) {
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
      return Response.json({ error: "Execution not found" }, { status: 404 });
    }

    const waitingStates = await listExecutionWaitingStates(executionId);

    if (waitingStates.length === 0) {
      requestLogger.warn("Execution is not waiting and cannot be cancelled");
      return Response.json(
        { error: "Execution is not currently waiting" },
        { status: 409 }
      );
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
      return Response.json(
        { error: "Execution is no longer waiting" },
        { status: 409 }
      );
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

    return Response.json({
      success: true,
      status: "cancelled",
      cancelledWaitStates: cancelledWaitStateIds.length,
    });
  } catch (error) {
    requestLogger.error("Failed to cancel execution", { error });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to cancel execution",
      },
      { status: 500 }
    );
  }
}
