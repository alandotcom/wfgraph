import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getRun } from "workflow/api";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { workflowExecutions } from "@/lib/db/schema";
import { logWorkflowAuditEvent } from "@/lib/workflow-audit";
import {
  listExecutionWaitingStates,
  markExecutionCancelled,
  markWaitingStatesCancelled,
} from "@/lib/workflow-wait-state";

export async function POST(
  request: Request,
  context: { params: Promise<{ executionId: string }> }
) {
  try {
    const { executionId } = await context.params;

    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      with: {
        workflow: true,
      },
    });

    if (!execution) {
      return NextResponse.json(
        { error: "Execution not found" },
        { status: 404 }
      );
    }

    if (execution.workflow.userId !== session.user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const waitingStates = await listExecutionWaitingStates(executionId);

    if (waitingStates.length === 0) {
      return NextResponse.json(
        { error: "Execution is not currently waiting" },
        { status: 409 }
      );
    }

    await logWorkflowAuditEvent({
      workflowId: execution.workflowId,
      executionId,
      userId: session.user.id,
      eventType: "run_cancel_requested",
      message: "Manual cancellation requested",
    });

    const runIds = new Set<string>();
    for (const waitState of waitingStates) {
      runIds.add(waitState.runId);
    }
    if (execution.workflowRunId) {
      runIds.add(execution.workflowRunId);
    }

    for (const runId of runIds) {
      try {
        await getRun(runId).cancel();
      } catch (error) {
        console.error(
          `[Execution Cancel] Failed to cancel run ${runId}:`,
          error
        );
      }
    }

    await markWaitingStatesCancelled(waitingStates.map((state) => state.id));
    await markExecutionCancelled({
      executionId,
      error: "Cancelled manually",
    });

    await logWorkflowAuditEvent({
      workflowId: execution.workflowId,
      executionId,
      userId: session.user.id,
      eventType: "run_cancelled",
      message: "Run cancelled manually while waiting",
      metadata: {
        waitingStates: waitingStates.length,
      },
    });

    return NextResponse.json({
      success: true,
      status: "cancelled",
      cancelledWaitStates: waitingStates.length,
    });
  } catch (error) {
    console.error("Failed to cancel execution:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to cancel execution",
      },
      { status: 500 }
    );
  }
}
