import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import {
  workflowExecutionLogs,
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

const executionStatusLogger = getAppLogger("workflow", "execution-status");

type NodeStatus = {
  nodeId: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
};

type ExecutionStatusResult = {
  status: string;
  nodeStatuses: NodeStatus[];
};

type ExecutionStatusError = { error: string };

export async function getExecutionStatusResult(
  executionId: string
): Promise<
  ServiceResult<
    ExecutionStatusResult,
    "not_found" | "internal",
    ExecutionStatusError
  >
> {
  const requestLogger = executionStatusLogger.with({ executionId });
  try {
    const execution = await db.query.workflowExecutions.findFirst({
      where: eq(workflowExecutions.id, executionId),
      columns: {
        id: true,
        status: true,
      },
    });

    if (!execution) {
      requestLogger.warn("Execution not found for status");
      return failure("not_found", { error: "Execution not found" });
    }

    const logs = await db.query.workflowExecutionLogs.findMany({
      where: eq(workflowExecutionLogs.executionId, executionId),
    });

    const nodeStatuses: NodeStatus[] = logs.map((log) => ({
      nodeId: log.nodeId,
      status:
        execution.status === "cancelled" &&
        (log.status === "pending" || log.status === "running")
          ? "cancelled"
          : log.status,
    }));

    return success({
      status: execution.status,
      nodeStatuses,
    });
  } catch (error) {
    requestLogger.error(
      `Failed to get execution status: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error
          ? error.message
          : "Failed to get execution status",
    });
  }
}

export async function getExecutionStatus(executionId: string) {
  return responseFromServiceResult(await getExecutionStatusResult(executionId));
}
