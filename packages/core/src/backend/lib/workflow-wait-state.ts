import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import { db } from "#src/backend/lib/db/index";
import {
  workflowExecutions,
  workflowWaitStates,
} from "#src/backend/lib/db/schema";

type WaitStatus = "waiting" | "resumed" | "timed_out" | "cancelled";

/**
 * The statuses a terminal write may replace: the one definition of "this
 * execution is still live" shared by every status writer, so a terminal
 * status can never be overwritten in either direction. `pending` never
 * occurs today (startWorkflowRun inserts `running`) but is in the column's
 * type, so the filter names it for completeness.
 */
export const IN_FLIGHT_EXECUTION_STATUSES = [
  "pending",
  "running",
  "waiting",
] as const;

/**
 * Parks the execution on a wait. The status flip runs first, behind the
 * in-flight guard: a policy cancel can land between the run's last step and
 * this park, and a cancelled execution must not gain a live wait row that
 * resume matching would later hit. Returns undefined when that race was
 * lost — the caller's run is already being cancelled by Inngest.
 */
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
  const flipped = await db
    .update(workflowExecutions)
    .set({
      status: "waiting",
      waitingAt: new Date(),
    })
    .where(
      and(
        eq(workflowExecutions.id, input.executionId),
        inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES])
      )
    )
    .returning({ id: workflowExecutions.id });

  if (flipped.length === 0) {
    return undefined;
  }

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

  return waitState;
}

export async function markExecutionRunning(executionId: string) {
  const result = await db
    .update(workflowExecutions)
    .set({
      status: "running",
      waitingAt: null,
    })
    .where(
      and(
        eq(workflowExecutions.id, executionId),
        eq(workflowExecutions.status, "waiting")
      )
    )
    .returning({ id: workflowExecutions.id });

  return result.length > 0;
}

/**
 * Compare-and-set: only an in-flight execution can become cancelled. A
 * running execution routinely completes between a policy cancel's candidate
 * query and this write; the guard keeps the finished row's status (and the
 * caller skips its audit event when this returns false).
 */
export async function markExecutionCancelled(input: {
  executionId: string;
  error?: string;
}) {
  const result = await db
    .update(workflowExecutions)
    .set({
      status: "cancelled",
      waitingAt: null,
      cancelledAt: new Date(),
      completedAt: new Date(),
      error: input.error,
    })
    .where(
      and(
        eq(workflowExecutions.id, input.executionId),
        inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES])
      )
    )
    .returning({ id: workflowExecutions.id });

  return result.length > 0;
}

export async function markWaitStateStatus(input: {
  waitStateId: string;
  status: Exclude<WaitStatus, "waiting">;
}) {
  const now = new Date();

  const result = await db
    .update(workflowWaitStates)
    .set({
      status: input.status,
      resumedAt:
        input.status === "resumed" || input.status === "timed_out" ? now : null,
      cancelledAt: input.status === "cancelled" ? now : null,
    })
    .where(
      and(
        eq(workflowWaitStates.id, input.waitStateId),
        eq(workflowWaitStates.status, "waiting")
      )
    )
    .returning({ id: workflowWaitStates.id });

  return result.length > 0;
}

export async function markWaitingStatesCancelled(waitStateIds: string[]) {
  if (waitStateIds.length === 0) {
    return [] as string[];
  }

  const updated = await db
    .update(workflowWaitStates)
    .set({
      status: "cancelled",
      cancelledAt: new Date(),
    })
    .where(
      and(
        inArray(workflowWaitStates.id, waitStateIds),
        eq(workflowWaitStates.status, "waiting")
      )
    )
    .returning({ id: workflowWaitStates.id });

  return updated.map((row) => row.id);
}

export async function listExecutionWaitingStates(executionId: string) {
  return await db.query.workflowWaitStates.findMany({
    where: and(
      eq(workflowWaitStates.executionId, executionId),
      eq(workflowWaitStates.status, "waiting")
    ),
  });
}

/**
 * The candidate set for a Replace/Cancel routing action: every execution for
 * this entity that a cancel can still reach, whatever node it is standing on.
 * runMode is a column here, so unlike the wait-state lookup no join is needed.
 */
export async function listWorkflowInFlightExecutionsByCorrelation(input: {
  workflowId: string;
  correlationKey: string;
  runMode: "live" | "test";
}) {
  return await db.query.workflowExecutions.findMany({
    columns: { id: true },
    where: and(
      eq(workflowExecutions.workflowId, input.workflowId),
      eq(workflowExecutions.correlationKey, input.correlationKey),
      eq(workflowExecutions.runMode, input.runMode),
      inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES])
    ),
  });
}

/**
 * The execution-status filter on the join makes reads self-healing: a wait
 * row orphaned by a partially failed cancellation (execution already
 * terminal, wait still `waiting`) never re-enters resume matching, where it
 * would silently consume a real event against a dead run.
 */
export async function listWorkflowWaitingStatesByCorrelation(input: {
  workflowId: string;
  correlationKey: string;
  runMode: "live" | "test";
}) {
  return await db
    .select(getTableColumns(workflowWaitStates))
    .from(workflowWaitStates)
    .innerJoin(
      workflowExecutions,
      eq(workflowWaitStates.executionId, workflowExecutions.id)
    )
    .where(
      and(
        eq(workflowWaitStates.workflowId, input.workflowId),
        eq(workflowWaitStates.correlationKey, input.correlationKey),
        eq(workflowWaitStates.status, "waiting"),
        eq(workflowExecutions.runMode, input.runMode),
        inArray(workflowExecutions.status, [...IN_FLIGHT_EXECUTION_STATUSES])
      )
    );
}
