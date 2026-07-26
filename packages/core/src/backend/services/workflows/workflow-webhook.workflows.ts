import { eq } from "drizzle-orm";
import { db } from "@/backend/lib/db";
import { workflows } from "@/backend/lib/db/schema";
import { responseFromServiceResult } from "@/backend/lib/http/response-from-service-result";
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
import { getErrorMessage } from "@/shared/utils";
import type { ApiErrorPayload } from "@/shared/workflow/api-contracts";
import type { WorkflowWebhookResponse } from "@/shared/workflow/execution-contracts";
import { evaluateWorkflowTrigger } from "@/shared/workflow/trigger-registry";
import { resolveWebhookTriggerRuntimeConfig } from "@/shared/workflow/triggers/webhook-trigger";
import { orchestrateTriggerExecution } from "./trigger-orchestrator.workflows";
import {
  buildIgnoredRunAuditMessage,
  recordTerminalWorkflowRun,
  startWorkflowRun,
} from "./workflow-run-lifecycle.workflows";

const webhookLogger = getAppLogger("workflow", "webhook");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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
}): Promise<
  ServiceResult<
    WorkflowWebhookResponse,
    "invalid" | "not_found" | "internal",
    ApiErrorPayload
  >
> {
  const requestLogger = webhookLogger.with({ workflowId: input.workflowId });
  try {
    const { workflowId, authHeader, body } = input;

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return failure("not_found", { error: "Workflow not found" });
    }

    const apiKeyValidation = await validateApiKey(authHeader);

    if (!apiKeyValidation.valid) {
      return failure("invalid", {
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
      const ignoredExecution = await recordTerminalWorkflowRun({
        workflowId,
        trigger: { type: "webhook" },
        payload: body,
        runMode,
        status: "success",
        output: {
          status: "ignored",
          reason: "workflow_paused",
          runMode,
        },
        audit: {
          eventType: "run_ignored",
          message: buildIgnoredRunAuditMessage({
            triggerType: "webhook",
            reason: "workflow_paused",
          }),
          metadata: {
            reason: "workflow_paused",
            runMode,
          },
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
        await startWorkflowRun({
          workflow: {
            id: workflowId,
            name: workflow.name,
            graph: workflowGraph,
          },
          trigger: { type: "webhook", eventType, correlationKey },
          payload: body,
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
        message: buildIgnoredRunAuditMessage({
          triggerType: "webhook",
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
    requestLogger.error(
      `Failed to start workflow execution: ${getErrorMessage(error)}`,
      { error }
    );
    return failure("internal", {
      error:
        error instanceof Error ? error.message : "Failed to execute workflow",
    });
  }
}
