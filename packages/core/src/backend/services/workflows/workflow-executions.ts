import { desc, eq, inArray } from "drizzle-orm";
import { db } from "#src/backend/lib/db/index";
import {
  workflowExecutionEvents,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "#src/backend/lib/service-result";
import { getErrorMessage } from "@rova/shared/utils";

const workflowExecutionsLogger = getAppLogger("workflow", "executions");

type WorkflowExecutionItem = {
  id: string;
  workflowId: string;
  status: "pending" | "running" | "waiting" | "success" | "error" | "cancelled";
  triggerType: "manual" | "webhook" | "event" | null;
  runMode: "live" | "test";
  triggerEventType: string | null;
  correlationKey: string | null;
  workflowRunId: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  waitingAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
  duration: string | null;
};

type WorkflowExecutionsError = { error: string };

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function toWorkflowExecutionItem(input: {
  id: string;
  workflowId: string;
  status: "pending" | "running" | "waiting" | "success" | "error" | "cancelled";
  triggerType: "manual" | "webhook" | "event" | null;
  runMode: "live" | "test";
  triggerEventType: string | null;
  correlationKey: string | null;
  workflowRunId: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: Date;
  waitingAt: Date | null;
  cancelledAt: Date | null;
  completedAt: Date | null;
  duration: string | null;
}): WorkflowExecutionItem {
  return {
    ...input,
    startedAt: input.startedAt.toISOString(),
    waitingAt: toIso(input.waitingAt),
    cancelledAt: toIso(input.cancelledAt),
    completedAt: toIso(input.completedAt),
  };
}

export async function getWorkflowExecutionsResult(
  workflowId: string
): Promise<
  ServiceResult<
    WorkflowExecutionItem[],
    "not_found" | "internal",
    WorkflowExecutionsError
  >
> {
  const requestLogger = workflowExecutionsLogger.with({ workflowId });
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
      columns: { id: true },
    });

    if (!workflow) {
      requestLogger.warn("Workflow not found for executions list");
      return failure("not_found", { error: "Workflow not found" });
    }

    const executions = await db.query.workflowExecutions.findMany({
      where: eq(workflowExecutions.workflowId, workflowId),
      orderBy: [desc(workflowExecutions.startedAt)],
      limit: 50,
    });

    return success(executions.map(toWorkflowExecutionItem));
  } catch (error) {
    requestLogger.error(
      `Failed to get workflow executions: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to get executions",
    });
  }
}

export async function deleteWorkflowExecutionsResult(
  workflowId: string
): Promise<
  ServiceResult<
    { success: true; deletedCount: number },
    "not_found" | "internal",
    WorkflowExecutionsError
  >
> {
  const requestLogger = workflowExecutionsLogger.with({ workflowId });
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
      columns: { id: true },
    });

    if (!workflow) {
      requestLogger.warn("Workflow not found for executions delete");
      return failure("not_found", { error: "Workflow not found" });
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

    return success({
      success: true,
      deletedCount: executionIds.length,
    });
  } catch (error) {
    requestLogger.error(
      `Failed to delete workflow executions: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to delete executions",
    });
  }
}
