import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import {
  workflowExecutions,
  workflowWaitStates,
} from "@/backend/lib/db/schema";

type WaitStatus = "waiting" | "resumed" | "timed_out" | "cancelled";

export async function createWaitState(input: {
  executionId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  waitType: "delay" | "hook";
  hookToken?: string;
  waitUntil?: Date;
  correlationKey?: string;
  metadata?: Record<string, unknown>;
}) {
  const [waitState] = await db
    .insert(workflowWaitStates)
    .values({
      executionId: input.executionId,
      workflowId: input.workflowId,
      runId: input.runId,
      nodeId: input.nodeId,
      nodeName: input.nodeName,
      waitType: input.waitType,
      status: "waiting",
      hookToken: input.hookToken,
      waitUntil: input.waitUntil,
      correlationKey: input.correlationKey,
      metadata: input.metadata,
    })
    .returning();

  await db
    .update(workflowExecutions)
    .set({
      status: "waiting",
      waitingAt: new Date(),
    })
    .where(eq(workflowExecutions.id, input.executionId));

  return waitState;
}

export async function markExecutionRunning(executionId: string) {
  await db
    .update(workflowExecutions)
    .set({
      status: "running",
      waitingAt: null,
    })
    .where(eq(workflowExecutions.id, executionId));
}

export async function markExecutionCancelled(input: {
  executionId: string;
  error?: string;
}) {
  await db
    .update(workflowExecutions)
    .set({
      status: "cancelled",
      waitingAt: null,
      cancelledAt: new Date(),
      completedAt: new Date(),
      error: input.error,
    })
    .where(eq(workflowExecutions.id, input.executionId));
}

export async function markWaitStateStatus(input: {
  waitStateId: string;
  status: Exclude<WaitStatus, "waiting">;
}) {
  const now = new Date();

  await db
    .update(workflowWaitStates)
    .set({
      status: input.status,
      resumedAt:
        input.status === "resumed" || input.status === "timed_out" ? now : null,
      cancelledAt: input.status === "cancelled" ? now : null,
    })
    .where(eq(workflowWaitStates.id, input.waitStateId));
}

export async function markWaitingStatesCancelled(waitStateIds: string[]) {
  if (waitStateIds.length === 0) {
    return;
  }

  await db
    .update(workflowWaitStates)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
    })
    .where(inArray(workflowWaitStates.id, waitStateIds));
}

export async function listExecutionWaitingStates(executionId: string) {
  return await db.query.workflowWaitStates.findMany({
    where: and(
      eq(workflowWaitStates.executionId, executionId),
      eq(workflowWaitStates.status, "waiting")
    ),
  });
}

export async function listWorkflowWaitingStatesByCorrelation(input: {
  workflowId: string;
  correlationKey: string;
}) {
  return await db.query.workflowWaitStates.findMany({
    where: and(
      eq(workflowWaitStates.workflowId, input.workflowId),
      eq(workflowWaitStates.correlationKey, input.correlationKey),
      eq(workflowWaitStates.status, "waiting")
    ),
  });
}
