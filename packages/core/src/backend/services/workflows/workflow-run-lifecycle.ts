import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflowExecutions } from "@/backend/lib/db/schema";
import { sendWorkflowRunRequested } from "@/backend/lib/inngest/runtime-events";
import {
  logWorkflowAuditEvent,
  type WorkflowAuditEventType,
} from "@/backend/lib/workflow-audit";
import type { JsonObject } from "@rova/shared/types/json";
import type { WorkflowExecutionIgnoredReason } from "@rova/shared/workflow/execution-contracts";
import type {
  SerializedWorkflowGraph,
  WorkflowMode,
} from "@rova/shared/workflow/types";

/**
 * Every way a run can enter the system. Manual comes from the execute route,
 * webhook from the inbound HTTP entrypoint, event from an Inngest listener.
 */
export type WorkflowRunTriggerType = "manual" | "webhook" | "event";

/** Identity of the workflow plus the graph the run will execute. */
export type WorkflowRunTarget = {
  id: string;
  name: string;
  graph: SerializedWorkflowGraph;
};

/** What trigger evaluation concluded about the payload that arrived. */
export type WorkflowRunTriggerContext = {
  type: WorkflowRunTriggerType;
  eventType?: string;
  correlationKey?: string;
};

export type StartWorkflowRunInput = {
  workflow: WorkflowRunTarget;
  trigger: WorkflowRunTriggerContext;
  runMode: WorkflowMode;
  /**
   * The payload the trigger node and downstream templates read from. It is JSON
   * because it arrived as JSON and is stored as JSON in the JSONB
   * `workflow_executions.input` column.
   */
  payload: JsonObject;
  /**
   * The untouched request body, kept alongside the payload so steps can reach
   * the raw shape. Entrypoints that never substitute a mock payload leave this
   * out and get the payload itself.
   */
  requestPayload?: JsonObject;
};

export type StartedWorkflowRun = {
  executionId: string;
  runId?: string;
  runMode: WorkflowMode;
};

export type RecordTerminalWorkflowRunInput = {
  workflowId: string;
  trigger: WorkflowRunTriggerContext;
  runMode: WorkflowMode;
  payload: JsonObject;
  status: "success" | "error" | "cancelled";
  error?: string;
  output?: Record<string, unknown>;
  audit: {
    eventType: Extract<
      WorkflowAuditEventType,
      "run_cancelled" | "run_ignored" | "run_completed"
    >;
    message: string;
    metadata?: Record<string, unknown>;
  };
};

/** How each entrypoint names itself in a "run started" timeline entry. */
const RUN_STARTED_LABELS: Record<WorkflowRunTriggerType, string> = {
  manual: "Manual",
  webhook: "Webhook",
  event: "Event-triggered",
};

/**
 * How each entrypoint names the thing it declined to run, phrased so it reads
 * as a noun inside "Ignored <subject> because ...".
 */
const IGNORED_SUBJECTS: Record<WorkflowRunTriggerType, string> = {
  manual: "execute event",
  webhook: "webhook event",
  event: "event",
};

export function buildRunStartedAuditMessage(input: {
  triggerType: WorkflowRunTriggerType;
  runMode: WorkflowMode;
  eventType?: string;
}): string {
  const label = RUN_STARTED_LABELS[input.triggerType];
  const mode = input.runMode === "test" ? " test mode" : "";
  const event = input.eventType ? ` for ${input.eventType}` : "";
  return `${label}${mode} run started${event}`;
}

export function buildIgnoredRunAuditMessage(input: {
  triggerType: WorkflowRunTriggerType;
  reason: WorkflowExecutionIgnoredReason;
  eventType?: string;
  eventTypePath?: string;
}): string {
  const subject = IGNORED_SUBJECTS[input.triggerType];

  if (input.reason === "workflow_paused") {
    return `Ignored ${subject} because workflow is paused`;
  }

  if (input.reason === "missing_event_type") {
    // Only name a path that is actually known; a fabricated default sends
    // the builder to fix a field the classifier never reads.
    return input.eventTypePath
      ? `Ignored ${subject}: event type missing at path "${input.eventTypePath}"`
      : `Ignored ${subject}: no event type was found in the payload`;
  }

  if (input.reason === "invalid_payload") {
    return `Ignored ${subject}: payload failed the trigger schema`;
  }

  if (input.reason === "event_not_mapped") {
    return input.eventType
      ? `Ignored ${subject} ${input.eventType}: not mapped by the routing policy`
      : `Ignored ${subject}: not mapped by the routing policy`;
  }

  return input.eventType
    ? `Ignored ${input.eventType} because no in-flight runs were found`
    : `Ignored ${subject} because no in-flight runs were found`;
}

/**
 * Inserts the execution row, enqueues the Inngest run, and records the timeline
 * entry. A failed enqueue marks the row as errored before rethrowing, so a run
 * is never left sitting in "running" with nothing behind it.
 */
export async function startWorkflowRun(
  input: StartWorkflowRunInput
): Promise<StartedWorkflowRun> {
  const { workflow, trigger, runMode, payload } = input;

  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: workflow.id,
      status: "running",
      triggerType: trigger.type,
      runMode,
      triggerEventType: trigger.eventType,
      correlationKey: trigger.correlationKey,
      input: payload,
    })
    .returning();

  const run = await sendWorkflowRunRequested({
    graph: workflow.graph,
    triggerInput: payload,
    requestPayload: input.requestPayload ?? payload,
    executionId: execution.id,
    workflowId: workflow.id,
    workflowName: workflow.name,
    runMode,
    eventContext: {
      eventType: trigger.eventType,
      correlationKey: trigger.correlationKey,
    },
  }).catch(async (error) => {
    await db
      .update(workflowExecutions)
      .set({
        status: "error",
        error: error instanceof Error ? error.message : "Failed to enqueue run",
        completedAt: new Date(),
      })
      .where(eq(workflowExecutions.id, execution.id));
    throw error;
  });

  await db
    .update(workflowExecutions)
    .set({ workflowRunId: run.eventId ?? null })
    .where(eq(workflowExecutions.id, execution.id));

  await logWorkflowAuditEvent({
    workflowId: workflow.id,
    executionId: execution.id,
    eventType: "run_started",
    message: buildRunStartedAuditMessage({
      triggerType: trigger.type,
      runMode,
      eventType: trigger.eventType,
    }),
    metadata: {
      triggerType: trigger.type,
      runMode,
      eventType: trigger.eventType,
      correlationKey: trigger.correlationKey,
      runId: run.eventId,
    },
  });

  return {
    executionId: execution.id,
    runId: run.eventId,
    runMode,
  };
}

/**
 * Writes an execution row for a request that reached a verdict without ever
 * running the graph, such as a cancellation or an ignored event. The row starts
 * and completes at the same instant so the run list still shows the decision.
 */
export async function recordTerminalWorkflowRun(
  input: RecordTerminalWorkflowRunInput
) {
  const now = new Date();
  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      status: input.status,
      triggerType: input.trigger.type,
      runMode: input.runMode,
      triggerEventType: input.trigger.eventType,
      correlationKey: input.trigger.correlationKey,
      input: input.payload,
      output: input.output,
      error: input.error,
      startedAt: now,
      completedAt: now,
      cancelledAt: input.status === "cancelled" ? now : null,
    })
    .returning();

  await logWorkflowAuditEvent({
    workflowId: input.workflowId,
    executionId: execution.id,
    eventType: input.audit.eventType,
    message: input.audit.message,
    metadata: input.audit.metadata,
  });

  return execution;
}
