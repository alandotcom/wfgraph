import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflowExecutions, workflows } from "@/backend/lib/db/schema";
import { sendWorkflowRunRequested } from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import { cancelWaitingRuns } from "@/backend/lib/workflow-cancellation";
import { resumeMatchingWaitHooks } from "@/backend/lib/workflow-wait-resume";
import { listWorkflowWaitingStatesByCorrelation } from "@/backend/lib/workflow-wait-state";
import { orchestrateTriggerExecution } from "@/backend/services/workflows/trigger-orchestrator.workflows";
import { runWorkflowExecutionPreflight } from "@/backend/services/workflows/workflow-execution-preflight.workflows";
import type { InngestEventTriggerConfig } from "@/shared/workflow/trigger-registry";
import { evaluateWorkflowTrigger } from "@/shared/workflow/trigger-registry";
import type { SerializedWorkflowGraph } from "@/shared/workflow/types";
import { getInngestClient } from "./client";

const eventListenerLogger = getAppLogger("workflow", "event-listener");

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ...value };
  }
  return {};
}

async function startEventExecution(input: {
  workflowId: string;
  workflowName: string;
  workflowGraph: SerializedWorkflowGraph;
  payload: Record<string, unknown>;
  eventType?: string;
  correlationKey?: string;
  runMode: "live" | "test";
}) {
  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      status: "running",
      triggerType: "event",
      runMode: input.runMode,
      triggerEventType: input.eventType,
      correlationKey: input.correlationKey,
      input: input.payload,
    })
    .returning();

  const run = await sendWorkflowRunRequested({
    graph: input.workflowGraph,
    triggerInput: input.payload,
    requestPayload: input.payload,
    executionId: execution.id,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    runMode: input.runMode,
    eventContext: {
      eventType: input.eventType,
      correlationKey: input.correlationKey,
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
    workflowId: input.workflowId,
    executionId: execution.id,
    eventType: "run_started",
    message: `${input.runMode === "test" ? "Event-triggered test mode run started" : "Event-triggered run started"}${input.eventType ? ` for ${input.eventType}` : ""}`,
    metadata: {
      triggerType: "event",
      runMode: input.runMode,
      eventType: input.eventType,
      correlationKey: input.correlationKey,
      runId: run.eventId,
    },
  });

  return {
    executionId: execution.id,
    runId: run.eventId,
    runMode: input.runMode,
  };
}

export function createInngestEventListenerFunction(input: {
  id: string;
  workflowId: string;
  inngestEventTrigger: InngestEventTriggerConfig;
}) {
  const { eventNames, functionOptions } = input.inngestEventTrigger;
  const eventLabel = eventNames.join(", ");

  const triggers = eventNames.map((name) => ({ event: name }));
  const triggerArg = triggers.length === 1 ? triggers[0] : triggers;

  return getInngestClient().createFunction(
    { ...functionOptions, id: input.id, name: `Event listener: ${eventLabel}` },
    triggerArg,
    async ({ event }) => {
      const payload = toRecord(event.data);

      const requestLogger = eventListenerLogger.with({
        workflowId: input.workflowId,
        inngestEventNames: eventNames,
      });

      const workflow = await db.query.workflows.findFirst({
        where: eq(workflows.id, input.workflowId),
      });

      if (!workflow) {
        requestLogger.error("Workflow not found for event listener");
        return { status: "error", reason: "workflow_not_found" };
      }

      const preflight = await runWorkflowExecutionPreflight({
        workflow,
        logger: requestLogger,
        requireExecutionType: "event",
      });

      if (!preflight.ok) {
        requestLogger.error("Event listener preflight failed", {
          workflowName: workflow.name,
        });
        return { status: "error", reason: "preflight_failed" };
      }

      const { workflowGraph, triggerConfig } = preflight.data;

      if (workflow.isPaused) {
        await logWorkflowAuditEvent({
          workflowId: input.workflowId,
          eventType: "run_ignored",
          message: "Ignored event because workflow is paused",
          metadata: { inngestEventName: eventLabel, runMode: workflow.mode },
        });
        return { status: "ignored", reason: "workflow_paused" };
      }

      const { eventType, correlationKey, routingDecision } =
        evaluateWorkflowTrigger({
          config: triggerConfig,
          payload,
        });

      requestLogger.info("Event trigger received", {
        workflowName: workflow.name,
        runMode: workflow.mode,
        eventType,
        correlationKey,
        payloadKeys: Object.keys(payload),
      });

      await logWorkflowAuditEvent({
        workflowId: input.workflowId,
        eventType: "trigger_received",
        message: `Event received: ${eventLabel}${eventType ? ` (${eventType})` : ""}`,
        metadata: { eventType, correlationKey, runMode: workflow.mode },
      });

      const waitingStates =
        correlationKey === undefined
          ? []
          : await listWorkflowWaitingStatesByCorrelation({
              workflowId: input.workflowId,
              correlationKey,
              runMode: workflow.mode,
            });

      const outcome = await orchestrateTriggerExecution({
        runMode: workflow.mode,
        eventType,
        correlationKey,
        routingDecision,
        waitStates: waitingStates,
        enableResumes: true,
        startExecution: async () =>
          await startEventExecution({
            workflowId: input.workflowId,
            workflowName: workflow.name,
            workflowGraph,
            payload,
            eventType,
            correlationKey,
            runMode: workflow.mode,
          }),
        cancelWaitStates: async (currentEventType) =>
          await cancelWaitingRuns({
            workflowId: input.workflowId,
            waitStates: waitingStates,
            eventType: currentEventType,
            reason: currentEventType
              ? `Cancelled by event ${currentEventType}`
              : "Cancelled by event trigger lifecycle decision",
            logger: eventListenerLogger,
          }),
        resumeWaitStates: async (currentEventType, waitStates) =>
          await resumeMatchingWaitHooks({
            workflowId: input.workflowId,
            eventType: currentEventType,
            payload,
            waitStates,
          }),
      });

      if (outcome.status === "ignored") {
        await logWorkflowAuditEvent({
          workflowId: input.workflowId,
          eventType: "run_ignored",
          message: `Ignored event ${eventLabel}${eventType ? ` (${eventType})` : ""}`,
          metadata: {
            eventType,
            correlationKey,
            reason: outcome.reason,
            runMode: workflow.mode,
          },
        });
      }

      return outcome;
    }
  );
}
