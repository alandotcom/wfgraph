import { desc, eq } from "drizzle-orm";
import { db } from "#src/backend/lib/db/index";
import {
  workflowExecutionLogs,
  workflowExecutions,
} from "#src/backend/lib/db/schema";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "#src/backend/lib/service-result";
import { redactSensitiveData } from "#src/backend/lib/utils/redact";
import { getErrorMessage } from "@rova/shared/utils";

const executionLogsLogger = getAppLogger("workflow", "execution-logs");

type ExecutionSummary = {
  id: string;
  workflowId: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  duration: string | null;
};

type ExecutionLogItem = {
  id: string;
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: "pending" | "running" | "success" | "error";
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  duration: string | null;
};

type ExecutionLogsResult = {
  execution: ExecutionSummary;
  logs: ExecutionLogItem[];
};

type ExecutionLogsError = { error: string };

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export async function getExecutionLogsResult(
  executionId: string
): Promise<
  ServiceResult<
    ExecutionLogsResult,
    "not_found" | "internal",
    ExecutionLogsError
  >
> {
  const requestLogger = executionLogsLogger.with({ executionId });
  try {
    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      columns: {
        id: true,
        workflowId: true,
        status: true,
        input: true,
        output: true,
        error: true,
        startedAt: true,
        completedAt: true,
        duration: true,
      },
    });

    if (!execution) {
      requestLogger.warn("Execution not found for logs");
      return failure("not_found", { error: "Execution not found" });
    }

    const logs = await db.query.workflowExecutionLogs.findMany({
      where: eq(workflowExecutionLogs.executionId, executionId),
      orderBy: [desc(workflowExecutionLogs.timestamp)],
    });

    const redactedLogs = logs.map((log) => ({
      id: log.id,
      executionId: log.executionId,
      nodeId: log.nodeId,
      nodeName: log.nodeName,
      nodeType: log.nodeType,
      status: log.status,
      input: redactSensitiveData(log.input),
      output: redactSensitiveData(log.output),
      error: log.error,
      startedAt: log.startedAt.toISOString(),
      completedAt: toIso(log.completedAt),
      duration: log.duration,
    }));

    return success({
      execution: {
        id: execution.id,
        workflowId: execution.workflowId,
        status: execution.status,
        input: execution.input,
        output: execution.output,
        error: execution.error,
        startedAt: execution.startedAt.toISOString(),
        completedAt: toIso(execution.completedAt),
        duration: execution.duration,
      },
      logs: redactedLogs,
    });
  } catch (error) {
    requestLogger.error(
      `Failed to get execution logs: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to get execution logs",
    });
  }
}
