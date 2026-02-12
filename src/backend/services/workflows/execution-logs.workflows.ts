import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowExecutionLogs, workflowExecutions } from "@/lib/db/schema";
import { getAppLogger } from "@/lib/logger";
import { redactSensitiveData } from "@/lib/utils/redact";

const executionLogsLogger = getAppLogger("workflow", "execution-logs");

export async function getExecutionLogs(executionId: string) {
  const requestLogger = executionLogsLogger.with({ executionId });
  try {
    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      with: {
        workflow: true,
      },
    });

    if (!execution) {
      requestLogger.warn("Execution not found for logs");
      return Response.json({ error: "Execution not found" }, { status: 404 });
    }

    const logs = await db.query.workflowExecutionLogs.findMany({
      where: eq(workflowExecutionLogs.executionId, executionId),
      orderBy: [desc(workflowExecutionLogs.timestamp)],
    });

    const redactedLogs = logs.map((log) => ({
      ...log,
      input: redactSensitiveData(log.input),
      output: redactSensitiveData(log.output),
    }));

    return Response.json({
      execution,
      logs: redactedLogs,
    });
  } catch (error) {
    requestLogger.error("Failed to get execution logs", { error });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get execution logs",
      },
      { status: 500 }
    );
  }
}
