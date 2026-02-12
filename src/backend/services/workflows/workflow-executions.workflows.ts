import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import {
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
  workflowWaitStates,
} from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";

const workflowExecutionsLogger = getAppLogger("workflow", "executions");

export async function getWorkflowExecutions(workflowId: string) {
  const requestLogger = workflowExecutionsLogger.with({ workflowId });
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
      columns: { id: true },
    });

    if (!workflow) {
      requestLogger.warn("Workflow not found for executions list");
      return Response.json({ error: "Workflow not found" }, { status: 404 });
    }

    const executions = await db.query.workflowExecutions.findMany({
      where: eq(workflowExecutions.workflowId, workflowId),
      orderBy: [desc(workflowExecutions.startedAt)],
      limit: 50,
    });

    return Response.json(executions);
  } catch (error) {
    requestLogger.error("Failed to get workflow executions", { error });
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to get executions",
      },
      { status: 500 }
    );
  }
}

export async function deleteWorkflowExecutions(workflowId: string) {
  const requestLogger = workflowExecutionsLogger.with({ workflowId });
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
      columns: { id: true },
    });

    if (!workflow) {
      requestLogger.warn("Workflow not found for executions delete");
      return Response.json({ error: "Workflow not found" }, { status: 404 });
    }

    const executions = await db.query.workflowExecutions.findMany({
      where: eq(workflowExecutions.workflowId, workflowId),
      columns: { id: true },
    });

    const executionIds = executions.map((e) => e.id);

    if (executionIds.length > 0) {
      await db
        .delete(workflowExecutionLogs)
        .where(inArray(workflowExecutionLogs.executionId, executionIds));

      await db
        .delete(workflowWaitStates)
        .where(inArray(workflowWaitStates.executionId, executionIds));

      await db
        .delete(workflowExecutionEvents)
        .where(inArray(workflowExecutionEvents.executionId, executionIds));

      await db
        .delete(workflowExecutions)
        .where(eq(workflowExecutions.workflowId, workflowId));
    }

    return Response.json({
      success: true,
      deletedCount: executionIds.length,
    });
  } catch (error) {
    requestLogger.error("Failed to delete workflow executions", { error });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete executions",
      },
      { status: 500 }
    );
  }
}
