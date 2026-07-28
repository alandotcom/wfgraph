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
import { resumeMatchingWaitHooks } from "@/backend/lib/workflow-wait-resume";
import { validateApiKey } from "@/backend/services/api-keys/auth";
import { runWorkflowExecutionPreflight } from "@/backend/services/workflows/workflow-execution-preflight";
import type { JsonObject } from "@rova/shared/types/json";
import { getErrorMessage } from "@rova/shared/utils";
import type { ApiErrorPayload } from "@rova/shared/workflow/api-contracts";
import type { WorkflowWebhookResponse } from "@rova/shared/workflow/execution-contracts";
import { routeWorkflowTrigger } from "@rova/shared/workflow/trigger-registry";
import { resolveWebhookTriggerRuntimeConfig } from "@rova/shared/workflow/triggers/webhook-trigger";
import { orchestrateRoutedTrigger } from "./trigger-routing";
import {
  buildIgnoredRunAuditMessage,
  recordTerminalWorkflowRun,
  startWorkflowRun,
} from "./workflow-run-lifecycle";

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
  body: JsonObject;
}) {
  return responseFromServiceResult(await postWorkflowWebhookResult(input), {
    headers: corsHeaders,
  });
}

export async function postWorkflowWebhookResult(input: {
  workflowId: string;
  authHeader: string | null;
  /**
   * The webhook body, already parsed from the request's JSON. It travels
   * unchanged to the trigger, onto the Inngest event, and into the JSONB
   * `workflow_executions.input` column, so JSON is the whole of its contract.
   */
  body: JsonObject;
}): Promise<
  ServiceResult<
    WorkflowWebhookResponse,
    "invalid" | "unauthorized" | "not_found" | "internal",
    ApiErrorPayload
  >
> {
  const requestLogger = webhookLogger.with({ workflowId: input.workflowId });
  try {
    const { workflowId, authHeader, body } = input;

    // Credentials before the lookup: answering "not found" versus
    // "unauthorized" to an unauthenticated caller tells them which ids exist,
    // and this route is reachable without a session by design.
    const apiKeyValidation = await validateApiKey(authHeader);

    if (!apiKeyValidation.valid) {
      return failure("unauthorized", {
        error: apiKeyValidation.error,
      });
    }

    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return failure("not_found", { error: "Workflow not found" });
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

    const routing = routeWorkflowTrigger({
      config: triggerConfig,
      payload: body,
    });
    const { eventType, correlationKey, action } = routing;
    const eventTypePath = webhookRuntimeConfig.routing.eventTypePath;
    const correlationPath = webhookRuntimeConfig.routing.correlationPath;

    requestLogger.info("Webhook request received", {
      workflowName: workflow.name,
      runMode,
      eventTypePath,
      correlationPath,
      eventType,
      correlationKey,
      action,
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

    const outcome = await orchestrateRoutedTrigger({
      workflowId,
      runMode,
      routing,
      sourceNoun: "webhook event",
      enableResumes: true,
      logger: webhookLogger,
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
