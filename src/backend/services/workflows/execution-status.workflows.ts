import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import {
  workflowExecutionLogs,
  workflowExecutions,
} from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";

const executionStatusLogger = getAppLogger("workflow", "execution-status");

type NodeStatus = {
  nodeId: string;
  status: "pending" | "running" | "success" | "error" | "cancelled";
};

export async function getExecutionStatus(executionId: string) {
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
      return Response.json({ error: "Execution not found" }, { status: 404 });
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

    return Response.json({
      status: execution.status,
      nodeStatuses,
    });
  } catch (error) {
    requestLogger.error("Failed to get execution status", { error });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to get execution status",
      },
      { status: 500 }
    );
  }
}
