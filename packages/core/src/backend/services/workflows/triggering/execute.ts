import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { seamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import { orchestrateRoutedTrigger } from "#src/backend/services/workflows/triggering/routing";
import { loadWorkflowForRun } from "#src/backend/services/workflows/triggering/preflight";
import {
  buildIgnoredRunAuditMessage,
  recordPausedRunIgnored,
  recordTerminalWorkflowRun,
  startWorkflowRun,
} from "#src/backend/services/workflows/triggering/run-lifecycle";
import type { JsonObject } from "@rova/shared/types/json";
import type { WorkflowExecuteResponse } from "@rova/shared/workflow/execution-contracts";
import { routeWorkflowTrigger } from "@rova/shared/workflow/trigger-registry";
import { resolveWebhookTriggerRuntimeConfig } from "@rova/shared/workflow/triggers/webhook-trigger";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "execute").with({ workflowId })
  );

export const postWorkflowExecute = Effect.fn("postWorkflowExecute")(
  function* (
    workflowId: string,
    body: {
      /**
       * The manual-run payload. It stands in for a webhook body, follows the
       * same path onto the Inngest event and into the JSONB
       * `workflow_executions.input` column, and so carries the same JSON-only
       * contract.
       */
      input?: JsonObject;
    }
  ) {
    const logger = yield* loggerFor(workflowId);

    const { workflow, preflight } = yield* loadWorkflowForRun({
      workflowId,
      logger,
    });

    const { workflowGraph, triggerConfig, triggerDefinition } = preflight;
    const triggerConfigRecord: Record<string, unknown> = triggerConfig ?? {};
    const triggerExecutionType = triggerDefinition.runtime.executionType;
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
      const ignoredExecution = yield* recordPausedRunIgnored({
        workflowId,
        triggerType: "manual",
        runMode,
        payload: effectiveInput,
      });

      const response: WorkflowExecuteResponse = {
        status: "ignored",
        executionId: ignoredExecution.id,
        runMode,
        reason: "workflow_paused",
      };
      return response;
    }

    // A manual run has no delivering Inngest event; classification owns the
    // sole-declared-event-name stand-in, so no eventName is passed here.
    const routing = routeWorkflowTrigger({
      config: triggerConfigRecord,
      payload: effectiveInput,
    });
    const { eventType, correlationKey, action } = routing;

    yield* logger.info("Workflow execute request received", {
      workflowName: workflow.name,
      triggerType: triggerDefinition.runtime.type.toLowerCase(),
      runMode,
      requestPayloadKeys: Object.keys(body.input ?? {}),
      effectiveInputKeys: Object.keys(effectiveInput),
      eventType,
      correlationKey,
      action,
    });

    // Only the two routed trigger kinds have a routing policy to act on; every
    // other trigger a manual run can name just starts.
    if (
      triggerExecutionType !== "webhook" &&
      triggerExecutionType !== "event"
    ) {
      const startedExecution = yield* startWorkflowRun({
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
      return response;
    }

    const orchestrated = yield* orchestrateRoutedTrigger({
      workflowId,
      runMode,
      routing,
      sourceNoun: "execute event",
      logger,
      startExecution: () =>
        startWorkflowRun({
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
      // No resume callback: a manual run has no delivering event, so there is
      // nothing here that could wake a waiting run, and "resumed" is not one of
      // the outcomes this call can be answered with.
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
      return response;
    }

    if (orchestrated.status === "cancelled") {
      let cancellationAuditMessage =
        "Cancelled in-flight runs from execute request";
      if (eventType) {
        cancellationAuditMessage = `Cancelled by execute event ${eventType}`;
      }

      const terminalExecution = yield* recordTerminalWorkflowRun({
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
      return response;
    }

    const ignoredReason = orchestrated.reason;
    const terminalExecution = yield* recordTerminalWorkflowRun({
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
    return response;
  },
  // A rejected query and a refused Inngest send both leave the caller with the
  // same nothing, and the operator with the same line to grep for.
  (effect, workflowId) =>
    effect.pipe(
      Effect.catchTags(
        seamFailureHandlers(
          loggerFor(workflowId),
          "Failed to start workflow execution",
          "Failed to execute workflow"
        )
      )
    )
);
