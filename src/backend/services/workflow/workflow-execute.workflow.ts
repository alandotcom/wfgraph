import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflowExecutions, workflows } from "@/backend/lib/db/schema";
import { responseFromServiceResult } from "@/backend/lib/http/response-from-service-result";
import { sendWorkflowRunRequested } from "@/backend/lib/inngest/runtime-events";
import { getAppLogger } from "@/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "@/backend/lib/service-result";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import { cancelWaitingRuns } from "@/backend/lib/workflow-cancellation";
import { listWorkflowWaitingStatesByCorrelation } from "@/backend/lib/workflow-wait-state";
import { orchestrateTriggerExecution } from "@/backend/services/workflows/trigger-orchestrator.workflows";
import { runWorkflowExecutionPreflight } from "@/backend/services/workflows/workflow-execution-preflight.workflows";
import type { ApiErrorPayload } from "@/shared/workflow/api-contracts";
import type { WorkflowExecuteResponse } from "@/shared/workflow/execution-contracts";
import { evaluateWorkflowTrigger } from "@/shared/workflow/trigger-registry";
import { resolveWebhookTriggerRuntimeConfig } from "@/shared/workflow/triggers/webhook-trigger";
import type { SerializedWorkflowGraph } from "@/shared/workflow/types";

const executeLogger = getAppLogger("workflow", "execute");

async function createTerminalExecution(input: {
  workflowId: string;
  triggerType: "manual" | "webhook";
  isDryRun: boolean;
  triggerEventType?: string;
  correlationKey?: string;
  payload: Record<string, unknown>;
  status: "success" | "error" | "cancelled";
  error?: string;
  output?: Record<string, unknown>;
  auditEventType: "run_cancelled" | "run_ignored" | "run_completed";
  auditMessage: string;
  auditMetadata?: Record<string, unknown>;
}) {
  const now = new Date();
  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      status: input.status,
      triggerType: input.triggerType,
      isDryRun: input.isDryRun,
      triggerEventType: input.triggerEventType,
      correlationKey: input.correlationKey,
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
    eventType: input.auditEventType,
    message: input.auditMessage,
    metadata: input.auditMetadata,
  });

  return execution;
}

async function startExecution(input: {
  workflowId: string;
  workflowName: string;
  workflowGraph: SerializedWorkflowGraph;
  triggerType: "manual" | "webhook";
  payload: Record<string, unknown>;
  requestPayload: Record<string, unknown>;
  eventType?: string;
  correlationKey?: string;
  dryRun: boolean;
}) {
  const [startedExecution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      status: "running",
      triggerType: input.triggerType,
      isDryRun: input.dryRun,
      triggerEventType: input.eventType,
      correlationKey: input.correlationKey,
      input: input.payload,
    })
    .returning();

  const run = await sendWorkflowRunRequested({
    graph: input.workflowGraph,
    triggerInput: input.payload,
    requestPayload: input.requestPayload,
    executionId: startedExecution.id,
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    dryRun: input.dryRun,
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
      .where(eq(workflowExecutions.id, startedExecution.id));
    throw error;
  });

  await db
    .update(workflowExecutions)
    .set({ workflowRunId: run.eventId ?? null })
    .where(eq(workflowExecutions.id, startedExecution.id));

  await logWorkflowAuditEvent({
    workflowId: input.workflowId,
    executionId: startedExecution.id,
    eventType: "run_started",
    message: input.dryRun ? "Manual dry run started" : "Manual run started",
    metadata: {
      triggerType: input.triggerType,
      dryRun: input.dryRun,
      eventType: input.eventType,
      correlationKey: input.correlationKey,
      runId: run.eventId,
    },
  });

  return {
    executionId: startedExecution.id,
    runId: run.eventId,
    dryRun: input.dryRun,
  };
}

function buildIgnoredAuditMessage(input: {
  reason:
    | "missing_event_type"
    | "event_not_configured"
    | "no_waiting_runs"
    | "workflow_paused";
  eventType?: string;
  eventTypePath?: string;
}): string {
  if (input.reason === "workflow_paused") {
    return "Ignored execute request because workflow is paused";
  }

  if (input.reason === "missing_event_type") {
    return `Ignored webhook event because event type is missing at path "${input.eventTypePath ?? "event"}"`;
  }

  if (input.reason === "event_not_configured") {
    return input.eventType
      ? `Ignored execute event ${input.eventType}`
      : "Ignored execute event not configured by trigger routing";
  }

  return input.eventType
    ? `Ignored ${input.eventType} because no waiting runs were found`
    : "Ignored event because no waiting runs were found";
}

export async function postWorkflowExecute(
  workflowId: string,
  body: {
    input?: Record<string, unknown>;
    dryRun?: boolean;
  }
) {
  return responseFromServiceResult(
    await postWorkflowExecuteResult(workflowId, body)
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Execute route coordinates trigger parsing, cancellation, and run creation in one request handler.
export async function postWorkflowExecuteResult(
  workflowId: string,
  body: {
    input?: Record<string, unknown>;
    dryRun?: boolean;
  }
): Promise<
  ServiceResult<WorkflowExecuteResponse, 400 | 403 | 404 | 500, ApiErrorPayload>
> {
  const requestLogger = executeLogger.with({ workflowId });
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return failure(404, { error: "Workflow not found" });
    }

    const preflight = await runWorkflowExecutionPreflight({
      workflow,
      logger: requestLogger,
    });
    if (!preflight.ok) {
      return preflight;
    }

    const { workflowGraph, triggerConfig, triggerDefinition } = preflight.data;
    const triggerConfigRecord: Record<string, unknown> = triggerConfig ?? {};
    const isWebhookTrigger =
      triggerDefinition.runtime.executionType === "webhook";
    const webhookRuntimeConfig = isWebhookTrigger
      ? resolveWebhookTriggerRuntimeConfig(triggerConfigRecord)
      : undefined;
    const input = body.input ?? {};
    const dryRun = body.dryRun === true;
    let effectiveInput = input;

    if (isWebhookTrigger && Object.keys(input).length === 0) {
      const mockInput = webhookRuntimeConfig?.mockInput;
      if (mockInput) {
        effectiveInput = mockInput;
      }
    }

    if (workflow.isPaused) {
      const ignoredExecution = await createTerminalExecution({
        workflowId,
        triggerType: "manual",
        isDryRun: dryRun,
        payload: effectiveInput,
        status: "success",
        output: {
          status: "ignored",
          reason: "workflow_paused",
          dryRun,
        },
        auditEventType: "run_ignored",
        auditMessage: buildIgnoredAuditMessage({
          reason: "workflow_paused",
        }),
        auditMetadata: {
          reason: "workflow_paused",
          dryRun,
        },
      });

      const response: WorkflowExecuteResponse = {
        status: "ignored",
        executionId: ignoredExecution.id,
        dryRun,
        reason: "workflow_paused",
      };
      return success(response);
    }

    const { eventType, correlationKey, routingDecision } =
      evaluateWorkflowTrigger({
        config: triggerConfigRecord,
        payload: effectiveInput,
      });

    requestLogger.info("Workflow execute request received", {
      workflowName: workflow.name,
      triggerType: triggerDefinition.runtime.type.toLowerCase(),
      dryRun,
      requestPayloadKeys: Object.keys(body.input ?? {}),
      effectiveInputKeys: Object.keys(effectiveInput),
      eventType,
      correlationKey,
    });

    if (!isWebhookTrigger) {
      const startedExecution = await startExecution({
        workflowId,
        workflowName: workflow.name,
        workflowGraph,
        triggerType: "manual",
        payload: effectiveInput,
        requestPayload: body.input ?? {},
        eventType,
        correlationKey,
        dryRun,
      });

      const response: WorkflowExecuteResponse = {
        status: "running",
        executionId: startedExecution.executionId,
        runId: startedExecution.runId,
        dryRun,
      };
      return success(response);
    }

    const waitStates =
      correlationKey === undefined
        ? []
        : await listWorkflowWaitingStatesByCorrelation({
            workflowId,
            correlationKey,
          });

    const orchestrated = await orchestrateTriggerExecution({
      dryRun,
      eventType,
      correlationKey,
      routingDecision,
      waitStates,
      enableResumes: false,
      startExecution: async () =>
        await startExecution({
          workflowId,
          workflowName: workflow.name,
          workflowGraph,
          triggerType: "webhook",
          payload: effectiveInput,
          requestPayload: body.input ?? {},
          eventType,
          correlationKey,
          dryRun,
        }),
      cancelWaitStates: async (currentEventType) =>
        await cancelWaitingRuns({
          workflowId,
          waitStates,
          eventType: currentEventType,
          reason: currentEventType
            ? `Cancelled by execute event ${currentEventType}`
            : "Cancelled by execute trigger lifecycle decision",
          logger: executeLogger,
        }),
      resumeWaitStates: async () => 0,
    });

    if (orchestrated.status === "running") {
      const response: WorkflowExecuteResponse = {
        status: "running",
        executionId: orchestrated.executionId,
        runId: orchestrated.runId,
        dryRun: orchestrated.dryRun,
        cancelledExecutions: orchestrated.cancelledExecutions,
        cancelledWaits: orchestrated.cancelledWaits,
        simulated: orchestrated.simulated,
      };
      return success(response);
    }

    if (orchestrated.status === "cancelled") {
      let cancellationAuditMessage =
        "Cancelled waiting runs from execute request";
      if (eventType && dryRun) {
        cancellationAuditMessage = `Simulated cancellation by execute event ${eventType}`;
      } else if (eventType) {
        cancellationAuditMessage = `Cancelled by execute event ${eventType}`;
      }

      const terminalExecution = await createTerminalExecution({
        workflowId,
        triggerType: "webhook",
        isDryRun: orchestrated.dryRun,
        triggerEventType: eventType,
        correlationKey,
        payload: effectiveInput,
        status: "cancelled",
        output: {
          status: orchestrated.status,
          dryRun: orchestrated.dryRun,
          simulated: orchestrated.simulated,
          cancelledExecutions: orchestrated.cancelledExecutions,
          cancelledWaits: orchestrated.cancelledWaits,
          failedExecutions: orchestrated.failedExecutions,
        },
        auditEventType: "run_cancelled",
        auditMessage: cancellationAuditMessage,
        auditMetadata: {
          eventType,
          correlationKey,
          cancelledExecutions: orchestrated.cancelledExecutions,
          cancelledWaits: orchestrated.cancelledWaits,
          failedExecutions: orchestrated.failedExecutions,
          simulated: orchestrated.simulated,
        },
      });

      const response: WorkflowExecuteResponse = {
        status: "cancelled",
        executionId: terminalExecution.id,
        dryRun: orchestrated.dryRun,
        cancelledExecutions: orchestrated.cancelledExecutions,
        cancelledWaits: orchestrated.cancelledWaits,
        failedExecutions: orchestrated.failedExecutions,
        simulated: orchestrated.simulated,
      };
      return success(response);
    }

    if (orchestrated.status === "resumed") {
      requestLogger.error(
        "Unexpected resumed outcome for manual execute orchestration"
      );
      return failure(500, {
        error: "Unexpected routing outcome while executing workflow",
      });
    }

    const ignoredReason = orchestrated.reason;
    const terminalExecution = await createTerminalExecution({
      workflowId,
      triggerType: "webhook",
      isDryRun: dryRun,
      triggerEventType: eventType,
      correlationKey,
      payload: effectiveInput,
      status: "success",
      output: {
        status: "ignored",
        reason: ignoredReason,
        dryRun,
      },
      auditEventType: "run_ignored",
      auditMessage: buildIgnoredAuditMessage({
        reason: ignoredReason,
        eventType,
        eventTypePath: webhookRuntimeConfig?.routing.eventTypePath,
      }),
      auditMetadata: {
        eventType,
        correlationKey,
        reason: ignoredReason,
        eventTypePath: webhookRuntimeConfig?.routing.eventTypePath,
        dryRun,
      },
    });

    const response: WorkflowExecuteResponse = {
      status: "ignored",
      executionId: terminalExecution.id,
      dryRun,
      reason: ignoredReason,
    };

    return success(response);
  } catch (error) {
    requestLogger.error("Failed to start workflow execution", { error });
    return failure(500, {
      error:
        error instanceof Error ? error.message : "Failed to execute workflow",
    });
  }
}
