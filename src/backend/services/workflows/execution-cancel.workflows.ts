import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { sendWorkflowCancelRequested } from "@/lib/inngest/runtime-events";
import { getAppLogger } from "@/lib/logger";
import { logWorkflowAuditEvent } from "@/lib/workflow-audit";
import {
  listExecutionWaitingStates,
  markExecutionCancelled,
  markWaitingStatesCancelled,
} from "@/lib/workflow-wait-state";

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

    await markWaitingStatesCancelled(waitingStates.map((state) => state.id));
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
        waitingStates: waitingStates.length,
      },
    });

    return Response.json({
      success: true,
      status: "cancelled",
      cancelledWaitStates: waitingStates.length,
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
