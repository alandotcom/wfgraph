import { eq } from "drizzle-orm";
import { db } from "#src/backend/lib/db/index";
import { workflows } from "#src/backend/lib/db/schema";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  failure,
  type ServiceResult,
  success,
} from "#src/backend/lib/service-result";
import { orchestrateRoutedTrigger } from "#src/backend/services/workflows/triggering/routing";
import { runWorkflowExecutionPreflight } from "#src/backend/services/workflows/triggering/preflight";
import {
  buildIgnoredRunAuditMessage,
  recordTerminalWorkflowRun,
  startWorkflowRun,
} from "#src/backend/services/workflows/triggering/run-lifecycle";
import type { JsonObject } from "@rova/shared/types/json";
import { getErrorMessage } from "@rova/shared/utils";
import type { ApiErrorPayload } from "@rova/shared/workflow/api-contracts";
import type { WorkflowExecuteResponse } from "@rova/shared/workflow/execution-contracts";
import { routeWorkflowTrigger } from "@rova/shared/workflow/trigger-registry";
import { resolveWebhookTriggerRuntimeConfig } from "@rova/shared/workflow/triggers/webhook-trigger";

const executeLogger = getAppLogger("workflow", "execute");

export async function postWorkflowExecuteResult(
  workflowId: string,
  body: {
    /**
     * The manual-run payload. It stands in for a webhook body, follows the same
     * path onto the Inngest event and into the JSONB
     * `workflow_executions.input` column, and so carries the same JSON-only
     * contract.
     */
    input?: JsonObject;
  }
): Promise<
  ServiceResult<
    WorkflowExecuteResponse,
    "invalid" | "not_found" | "internal",
    ApiErrorPayload
  >
> {
  const requestLogger = executeLogger.with({ workflowId });
  try {
    const workflow = await db.query.workflows.findFirst({
      where: eq(workflows.id, workflowId),
    });

    if (!workflow) {
      return failure("not_found", { error: "Workflow not found" });
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
    const triggerExecutionType = triggerDefinition.runtime.executionType;
    const isOrchestratedTrigger =
      triggerExecutionType === "webhook" || triggerExecutionType === "event";
    const webhookRuntimeConfig =
      triggerExecutionType === "webhook"
        ? resolveWebhookTriggerRuntimeConfig(triggerConfigRecord)
        : undefined;
    const input = body.input ?? {};
    const runMode = workflow.mode;
    let effectiveInput = input;

    if (triggerExecutionType === "webhook" && Object.keys(input).length === 0) {
      const mockInput = webhookRuntimeConfig?.mockInput;
      if (mockInput) {
        effectiveInput = mockInput;
      }
    }

    if (workflow.isPaused) {
      const ignoredExecution = await recordTerminalWorkflowRun({
        workflowId,
        trigger: { type: "manual" },
        runMode,
        payload: effectiveInput,
        status: "success",
        output: {
          status: "ignored",
          reason: "workflow_paused",
          runMode,
        },
        audit: {
          eventType: "run_ignored",
          message: buildIgnoredRunAuditMessage({
            triggerType: "manual",
            reason: "workflow_paused",
          }),
          metadata: {
            reason: "workflow_paused",
            runMode,
          },
        },
      });

      const response: WorkflowExecuteResponse = {
        status: "ignored",
        executionId: ignoredExecution.id,
        runMode,
        reason: "workflow_paused",
      };
      return success(response);
    }

    // A manual run has no delivering Inngest event; classification owns the
    // sole-declared-event-name stand-in, so no eventName is passed here.
    const routing = routeWorkflowTrigger({
      config: triggerConfigRecord,
      payload: effectiveInput,
    });
    const { eventType, correlationKey, action } = routing;

    requestLogger.info("Workflow execute request received", {
      workflowName: workflow.name,
      triggerType: triggerDefinition.runtime.type.toLowerCase(),
      runMode,
      requestPayloadKeys: Object.keys(body.input ?? {}),
      effectiveInputKeys: Object.keys(effectiveInput),
      eventType,
      correlationKey,
      action,
    });

    if (!isOrchestratedTrigger) {
      const startedExecution = await startWorkflowRun({
        workflow: {
          id: workflowId,
          name: workflow.name,
          graph: workflowGraph,
        },
        trigger: { type: "manual", eventType, correlationKey },
        payload: effectiveInput,
        requestPayload: body.input ?? {},
        runMode,
      });

      const response: WorkflowExecuteResponse = {
        status: "running",
        executionId: startedExecution.executionId,
        runId: startedExecution.runId,
        runMode,
      };
      return success(response);
    }

    const orchestrated = await orchestrateRoutedTrigger({
      workflowId,
      runMode,
      routing,
      sourceNoun: "execute event",
      enableResumes: false,
      logger: executeLogger,
      startExecution: async () =>
        await startWorkflowRun({
          workflow: {
            id: workflowId,
            name: workflow.name,
            graph: workflowGraph,
          },
          trigger: { type: triggerExecutionType, eventType, correlationKey },
          payload: effectiveInput,
          requestPayload: body.input ?? {},
          runMode,
        }),
      resumeWaitStates: async () => 0,
    });

    if (orchestrated.status === "running") {
      const response: WorkflowExecuteResponse = {
        status: "running",
        executionId: orchestrated.executionId,
        runId: orchestrated.runId,
        runMode: orchestrated.runMode,
        cancelledExecutions: orchestrated.cancelledExecutions,
        cancelledWaits: orchestrated.cancelledWaits,
        failedExecutions: orchestrated.failedExecutions,
      };
      return success(response);
    }

    if (orchestrated.status === "cancelled") {
      let cancellationAuditMessage =
        "Cancelled in-flight runs from execute request";
      if (eventType) {
        cancellationAuditMessage = `Cancelled by execute event ${eventType}`;
      }

      const terminalExecution = await recordTerminalWorkflowRun({
        workflowId,
        trigger: { type: triggerExecutionType, eventType, correlationKey },
        runMode: orchestrated.runMode,
        payload: effectiveInput,
        status: "cancelled",
        output: {
          status: orchestrated.status,
          runMode: orchestrated.runMode,
          cancelledExecutions: orchestrated.cancelledExecutions,
          cancelledWaits: orchestrated.cancelledWaits,
          failedExecutions: orchestrated.failedExecutions,
        },
        audit: {
          eventType: "run_cancelled",
          message: cancellationAuditMessage,
          metadata: {
            eventType,
            correlationKey,
            cancelledExecutions: orchestrated.cancelledExecutions,
            cancelledWaits: orchestrated.cancelledWaits,
            failedExecutions: orchestrated.failedExecutions,
          },
        },
      });

      const response: WorkflowExecuteResponse = {
        status: "cancelled",
        executionId: terminalExecution.id,
        runMode: orchestrated.runMode,
        cancelledExecutions: orchestrated.cancelledExecutions,
        cancelledWaits: orchestrated.cancelledWaits,
        failedExecutions: orchestrated.failedExecutions,
      };
      return success(response);
    }

    if (orchestrated.status === "resumed") {
      requestLogger.error(
        "Unexpected resumed outcome for manual execute orchestration"
      );
      return failure("internal", {
        error: "Unexpected routing outcome while executing workflow",
      });
    }

    const ignoredReason = orchestrated.reason;
    const terminalExecution = await recordTerminalWorkflowRun({
      workflowId,
      trigger: { type: triggerExecutionType, eventType, correlationKey },
      runMode,
      payload: effectiveInput,
      status: "success",
      output: {
        status: "ignored",
        reason: ignoredReason,
        runMode,
      },
      audit: {
        eventType: "run_ignored",
        message: buildIgnoredRunAuditMessage({
          triggerType: "manual",
          reason: ignoredReason,
          eventType,
          eventTypePath: webhookRuntimeConfig?.routing.eventTypePath,
        }),
        metadata: {
          eventType,
          correlationKey,
          reason: ignoredReason,
          eventTypePath: webhookRuntimeConfig?.routing.eventTypePath,
          runMode,
        },
      },
    });

    const response: WorkflowExecuteResponse = {
      status: "ignored",
      executionId: terminalExecution.id,
      runMode,
      reason: ignoredReason,
    };

    return success(response);
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
