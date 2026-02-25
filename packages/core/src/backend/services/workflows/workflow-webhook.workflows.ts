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
import { resumeMatchingWaitHooks } from "@/backend/lib/workflow-wait-resume";
import { listWorkflowWaitingStatesByCorrelation } from "@/backend/lib/workflow-wait-state";
import { validateApiKey } from "@/backend/services/api-keys/auth.api-keys";
import { runWorkflowExecutionPreflight } from "@/backend/services/workflows/workflow-execution-preflight.workflows";
import type { ApiErrorPayload } from "@/shared/workflow/api-contracts";
import type { WorkflowWebhookResponse } from "@/shared/workflow/execution-contracts";
import { evaluateWorkflowTrigger } from "@/shared/workflow/trigger-registry";
import { resolveWebhookTriggerRuntimeConfig } from "@/shared/workflow/triggers/webhook-trigger";
import type { SerializedWorkflowGraph } from "@/shared/workflow/types";
import { orchestrateTriggerExecution } from "./trigger-orchestrator.workflows";

const webhookLogger = getAppLogger("workflow", "webhook");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function startWebhookExecution(input: {
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
      triggerType: "webhook",
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
    .set({
      workflowRunId: run.eventId ?? null,
    })
    .where(eq(workflowExecutions.id, execution.id));

  await logWorkflowAuditEvent({
    workflowId: input.workflowId,
    executionId: execution.id,
    eventType: "run_started",
    message: `${input.runMode === "test" ? "Webhook test mode run started" : "Webhook run started"}${input.eventType ? ` for ${input.eventType}` : ""}`,
    metadata: {
      triggerType: "webhook",
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

async function createTerminalWebhookExecution(input: {
  workflowId: string;
  payload: Record<string, unknown>;
  runMode: "live" | "test";
  status: "success" | "cancelled";
  eventType?: string;
  correlationKey?: string;
  output: Record<string, unknown>;
  auditEventType: "run_ignored" | "run_cancelled";
  auditMessage: string;
  auditMetadata?: Record<string, unknown>;
}) {
  const now = new Date();
  const [execution] = await db
    .insert(workflowExecutions)
    .values({
      workflowId: input.workflowId,
      status: input.status,
      triggerType: "webhook",
      runMode: input.runMode,
      triggerEventType: input.eventType,
      correlationKey: input.correlationKey,
      input: input.payload,
      output: input.output,
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
    return "Ignored webhook event because workflow is paused";
  }

  if (input.reason === "missing_event_type") {
    return `Ignored webhook: event type missing at path "${input.eventTypePath ?? "event"}"`;
  }

  if (input.reason === "event_not_configured") {
    return input.eventType
      ? `Ignored webhook event ${input.eventType}`
      : "Ignored webhook event not configured by routing";
  }

  return input.eventType
    ? `Ignored ${input.eventType} because no waiting runs were found`
    : "Ignored webhook event because no waiting runs were found";
}

export function optionsWorkflowWebhook() {
  return Response.json({}, { headers: corsHeaders });
}

export async function postWorkflowWebhook(input: {
  workflowId: string;
  authHeader: string | null;
  body: Record<string, unknown>;
}) {
  return responseFromServiceResult(await postWorkflowWebhookResult(input), {
    headers: corsHeaders,
  });
}

export async function postWorkflowWebhookResult(input: {
  workflowId: string;
  authHeader: string | null;
  body: Record<string, unknown>;
}): Promise<ServiceResult<WorkflowWebhookResponse, number, ApiErrorPayload>> {
  const requestLogger = webhookLogger.with({ workflowId: input.workflowId });
  try {
    const { workflowId, authHeader, body } = input;

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return failure(404, { error: "Workflow not found" });
    }

    const apiKeyValidation = await validateApiKey(authHeader);

    if (!apiKeyValidation.valid) {
      return failure(apiKeyValidation.statusCode || 401, {
        error: apiKeyValidation.error,
      });
    }

    const preflight = await runWorkflowExecutionPreflight({
      workflow,
      logger: requestLogger,
      requireExecutionType: "webhook",
    });
    if (!preflight.ok) {
      return preflight;
    }

    const { workflowGraph, triggerConfig } = preflight.data;
    const webhookRuntimeConfig =
      resolveWebhookTriggerRuntimeConfig(triggerConfig);

    const runMode = workflow.mode;

    if (workflow.isPaused) {
      const ignoredExecution = await createTerminalWebhookExecution({
        workflowId,
        payload: body,
        runMode,
        status: "success",
        output: {
          status: "ignored",
          reason: "workflow_paused",
          runMode,
        },
        auditEventType: "run_ignored",
        auditMessage: buildIgnoredAuditMessage({
          reason: "workflow_paused",
        }),
        auditMetadata: {
          reason: "workflow_paused",
          runMode,
        },
      });

      return success({
        status: "ignored",
        executionId: ignoredExecution.id,
        runMode,
        reason: "workflow_paused",
      });
    }

    const { eventType, correlationKey, routingDecision } =
      evaluateWorkflowTrigger({
        config: triggerConfig,
        payload: body,
      });
    const eventTypePath = webhookRuntimeConfig.routing.eventTypePath;
    const correlationPath = webhookRuntimeConfig.routing.correlationPath;

    requestLogger.info("Webhook request received", {
      workflowName: workflow.name,
      runMode,
      eventTypePath,
      correlationPath,
      eventType,
      correlationKey,
      requestPayloadKeys: Object.keys(body),
    });

    await logWorkflowAuditEvent({
      workflowId,
      eventType: "trigger_received",
      message: `Webhook received${eventType ? `: ${eventType}` : ""}`,
      metadata: {
        eventType,
        correlationKey,
        runMode,
      },
    });

    const waitingStates =
      correlationKey === undefined
        ? []
        : await listWorkflowWaitingStatesByCorrelation({
            workflowId,
            correlationKey,
            runMode,
          });

    const outcome = await orchestrateTriggerExecution({
      runMode,
      eventType,
      correlationKey,
      routingDecision,
      waitStates: waitingStates,
      enableResumes: true,
      startExecution: async () =>
        await startWebhookExecution({
          workflowId,
          workflowName: workflow.name,
          workflowGraph,
          payload: body,
          eventType,
          correlationKey,
          runMode,
        }),
      cancelWaitStates: async (currentEventType) =>
        await cancelWaitingRuns({
          workflowId,
          waitStates: waitingStates,
          eventType: currentEventType,
          reason: currentEventType
            ? `Cancelled by webhook event ${currentEventType}`
            : "Cancelled by webhook trigger lifecycle decision",
          logger: webhookLogger,
        }),
      resumeWaitStates: async (currentEventType, waitStates) =>
        await resumeMatchingWaitHooks({
          workflowId,
          eventType: currentEventType,
          payload: body,
          waitStates,
        }),
    });

    if (outcome.status === "ignored") {
      await logWorkflowAuditEvent({
        workflowId,
        eventType: "run_ignored",
        message: buildIgnoredAuditMessage({
          reason: outcome.reason,
          eventType,
          eventTypePath,
        }),
        metadata: {
          eventType,
          eventTypePath,
          correlationPath,
          correlationKey,
          runMode,
          reason: outcome.reason,
        },
      });
    }

    return success(outcome);
  } catch (error) {
    requestLogger.error("Failed to start workflow execution", { error });
    return failure(500, {
      error:
        error instanceof Error ? error.message : "Failed to execute workflow",
    });
  }
}
