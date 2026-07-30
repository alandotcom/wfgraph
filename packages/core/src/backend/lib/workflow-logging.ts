/**
 * Server-only workflow logging functions
 * These replace the HTTP endpoint for better security
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "#src/backend/lib/db/index";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@rova/shared/workflow/execution-contracts";
import {
  workflowExecutionLogs,
  workflowExecutions,
} from "#src/backend/lib/db/schema";

export type LogStepStartParams = {
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  input?: unknown;
};

export type LogStepStartResult = {
  logId: string;
  startTime: number;
};

/**
 * Log the start of a step execution
 */
export async function logStepStartDb(
  params: LogStepStartParams
): Promise<LogStepStartResult> {
  const [log] = await db
    .insert(workflowExecutionLogs)
    .values({
      executionId: params.executionId,
      nodeId: params.nodeId,
      nodeName: params.nodeName,
      nodeType: params.nodeType,
      status: "running",
      input: params.input,
      startedAt: new Date(),
    })
    .returning();

  return {
    logId: log.id,
    startTime: Date.now(),
  };
}

export type LogStepCompleteParams = {
  logId: string;
  startTime: number;
  status: "success" | "error";
  output?: unknown;
  error?: string;
};

/**
 * Log the completion of a step execution
 */
export async function logStepCompleteDb(
  params: LogStepCompleteParams
): Promise<void> {
  const duration = Date.now() - params.startTime;

  await db
    .update(workflowExecutionLogs)
    .set({
      status: params.status,
      output: params.output,
      error: params.error,
      completedAt: new Date(),
      duration: duration.toString(),
    })
    .where(eq(workflowExecutionLogs.id, params.logId));
}

export type LogWorkflowCompleteParams = {
  executionId: string;
  status: "completed" | "failed" | "canceled";
  output?: unknown;
  error?: string;
  startTime: number;
};

/**
 * Log the completion of a workflow execution.
 *
 * Compare-and-set, mirroring `endInFlightExecution`: a cancel can flip the row
 * to `canceled` while the run is finishing its last step, and the losing
 * completion write must not resurrect it. Returns whether this write recorded
 * the terminal status.
 */
export async function logWorkflowCompleteDb(
  params: LogWorkflowCompleteParams
): Promise<boolean> {
  const duration = Date.now() - params.startTime;

  const updated = await db
    .update(workflowExecutions)
    .set({
      status: params.status,
      output: params.output,
      error: params.error,
      waitingAt: null,
      completedAt: new Date(),
      duration: duration.toString(),
    })
    .where(
      and(
        eq(workflowExecutions.id, params.executionId),
        inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES])
      )
    )
    .returning({ id: workflowExecutions.id });

  return updated.length > 0;
}
