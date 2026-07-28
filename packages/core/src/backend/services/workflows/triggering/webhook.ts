import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { callDbModule } from "#src/backend/lib/effect/database";
import { seamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import { callInngestModule } from "#src/backend/lib/effect/inngest-client";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import { resumeMatchingWaitHooks } from "#src/backend/lib/workflow-wait-resume";
import { validateApiKey } from "#src/backend/services/api-keys/auth";
import { loadWorkflowForRun } from "#src/backend/services/workflows/triggering/preflight";
import type { JsonObject } from "@rova/shared/types/json";
import { routeWorkflowTrigger } from "@rova/shared/workflow/trigger-registry";
import { resolveWebhookTriggerRuntimeConfig } from "@rova/shared/workflow/triggers/webhook-trigger";
import { orchestrateRoutedTrigger } from "#src/backend/services/workflows/triggering/routing";
import {
  buildIgnoredRunAuditMessage,
  recordPausedRunIgnored,
  startWorkflowRun,
} from "#src/backend/services/workflows/triggering/run-lifecycle";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "webhook").with({ workflowId })
  );

export const postWorkflowWebhook = Effect.fn("postWorkflowWebhook")(
  function* (input: {
    workflowId: string;
    authHeader: string | null;
    /**
     * The webhook body, already parsed from the request's JSON. It travels
     * unchanged to the trigger, onto the Inngest event, and into the JSONB
     * `workflow_executions.input` column, so JSON is the whole of its contract.
     */
    body: JsonObject;
  }) {
    const { workflowId, authHeader, body } = input;
    const logger = yield* loggerFor(workflowId);

    // Credentials before the lookup: answering "not found" versus
    // "unauthorized" to an unauthenticated caller tells them which ids exist,
    // and this route is reachable without a session by design.
    yield* validateApiKey(authHeader);

    const { workflow, preflight } = yield* loadWorkflowForRun({
      workflowId,
      logger,
      requireExecutionType: "webhook",
    });

    const { workflowGraph, triggerConfig } = preflight;
    const webhookRuntimeConfig =
      resolveWebhookTriggerRuntimeConfig(triggerConfig);

    const runMode = workflow.mode;

    if (workflow.isPaused) {
      const ignoredExecution = yield* recordPausedRunIgnored({
        workflowId,
        triggerType: "webhook",
        runMode,
        payload: body,
      });

      return {
        status: "ignored",
        executionId: ignoredExecution.id,
        runMode,
        reason: "workflow_paused",
      } as const;
    }

    const routing = routeWorkflowTrigger({
      config: triggerConfig,
      payload: body,
    });
    const { eventType, correlationKey, action } = routing;
    const eventTypePath = webhookRuntimeConfig.routing.eventTypePath;
    const correlationPath = webhookRuntimeConfig.routing.correlationPath;

    yield* logger.info("Webhook request received", {
      workflowName: workflow.name,
      runMode,
      eventTypePath,
      correlationPath,
      eventType,
      correlationKey,
      action,
      requestPayloadKeys: Object.keys(body),
    });

    yield* callDbModule(() =>
      logWorkflowAuditEvent({
        workflowId,
        eventType: "trigger_received",
        message: `Webhook received${eventType ? `: ${eventType}` : ""}`,
        metadata: {
          eventType,
          correlationKey,
          runMode,
        },
      })
    );

    const outcome = yield* orchestrateRoutedTrigger({
      workflowId,
      runMode,
      routing,
      sourceNoun: "webhook event",
      logger,
      startExecution: () =>
        startWorkflowRun({
          workflow: {
            id: workflowId,
            name: workflow.name,
            graph: workflowGraph,
          },
          trigger: { type: "webhook", eventType, correlationKey },
          payload: body,
          runMode,
        }),
      resumeWaitStates: (currentEventType, waitStates) =>
        callInngestModule(() =>
          resumeMatchingWaitHooks({
            workflowId,
            eventType: currentEventType,
            payload: body,
            waitStates,
          })
        ),
    });

    // A routed ignore stops at the audit entry, with no execution row behind it.
    // That is deliberate: the sender reads the HTTP response and learns the
    // verdict from it, so the row would only be a per-request entry in a list
    // nobody consults for this path.
    if (outcome.status === "ignored") {
      yield* callDbModule(() =>
        logWorkflowAuditEvent({
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
        })
      );
    }

    return outcome;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchTags(
        seamFailureHandlers(
          loggerFor(input.workflowId),
          "Failed to start workflow execution",
          "Failed to execute workflow"
        )
      )
    )
);
