import { desc, eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import {
  workflowExecutionEvents,
  workflowExecutions,
} from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";

const executionEventsLogger = getAppLogger("workflow", "execution-events");

export async function getExecutionEvents(executionId: string) {
  const requestLogger = executionEventsLogger.with({ executionId });
  try {
    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      with: {
        workflow: true,
      },
    });

    if (!execution) {
      requestLogger.warn("Execution not found for events");
      return Response.json({ error: "Execution not found" }, { status: 404 });
    }

    const events = await db.query.workflowExecutionEvents.findMany({
      where: eq(workflowExecutionEvents.executionId, executionId),
      orderBy: [desc(workflowExecutionEvents.createdAt)],
      limit: 200,
    });

    return Response.json({ events });
  } catch (error) {
    requestLogger.error("Failed to get execution events", { error });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get execution events",
      },
      { status: 500 }
    );
  }
}
