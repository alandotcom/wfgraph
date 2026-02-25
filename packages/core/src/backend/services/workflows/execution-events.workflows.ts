import { desc, eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import {
  workflowExecutionEvents,
  workflowExecutions,
} from "@/backend/lib/db/schema";
import { responseFromServiceResult } from "@/backend/lib/http/response-from-service-result";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { getErrorMessage } from "@/shared/utils";

const executionEventsLogger = getAppLogger("workflow", "execution-events");

type ExecutionEvent = {
  id: string;
  workflowId: string;
  executionId: string | null;
  eventType: string;
  message: string;
  metadata: unknown;
  createdAt: string;
};

type ExecutionEventsResult = {
  events: ExecutionEvent[];
};

type ExecutionEventsError = { error: string };

export async function getExecutionEventsResult(
  executionId: string
): Promise<
  ServiceResult<ExecutionEventsResult, 404 | 500, ExecutionEventsError>
> {
  const requestLogger = executionEventsLogger.with({ executionId });
  try {
    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      columns: { id: true },
    });

    if (!execution) {
      requestLogger.warn("Execution not found for events");
      return failure(404, { error: "Execution not found" });
    }

    const events = await db.query.workflowExecutionEvents.findMany({
      where: eq(workflowExecutionEvents.executionId, executionId),
      orderBy: [desc(workflowExecutionEvents.createdAt)],
      limit: 200,
    });

    return success({
      events: events.map((event) => ({
        id: event.id,
        workflowId: event.workflowId,
        executionId: event.executionId,
        eventType: event.eventType,
        message: event.message,
        metadata: event.metadata,
        createdAt: event.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    requestLogger.error(
      `Failed to get execution events: ${getErrorMessage(error)}`,
      { error }
    );
    return failure(500, {
      error:
        error instanceof Error
          ? error.message
          : "Failed to get execution events",
    });
  }
}

export async function getExecutionEvents(executionId: string) {
  return responseFromServiceResult(await getExecutionEventsResult(executionId));
}
