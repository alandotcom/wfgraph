import { eq } from "drizzle-orm";
import type { InngestFunction } from "inngest";
import { db } from "@/backend/lib/db";
import { workflows } from "@/backend/lib/db/schema";
import { getAppLogger } from "@/backend/lib/logger";
import { logWorkflowAuditEvent } from "@/backend/lib/workflow-audit";
import { resumeMatchingWaitHooks } from "@/backend/lib/workflow-wait-resume";
import { orchestrateRoutedTrigger } from "@/backend/services/workflows/trigger-routing";
import { runWorkflowExecutionPreflight } from "@/backend/services/workflows/workflow-execution-preflight";
import { startWorkflowRun } from "@/backend/services/workflows/workflow-run-lifecycle";
import { type JsonObject, jsonObjectSchema } from "@rova/shared/types/json";
import type { InngestEventTriggerConfig } from "@rova/shared/workflow/trigger-registry";
import { routeWorkflowTrigger } from "@rova/shared/workflow/trigger-registry";
import { getInngestClient } from "./client";

const eventListenerLogger = getAppLogger("workflow", "event-listener");

/**
 * Reads the trigger payload off an Inngest event.
 *
 * Inngest serializes event data with `JSON.stringify` before sending it, so
 * whatever the application passed to `inngest.send(...)` reaches us as JSON.
 * This parse is where that fact becomes a type. An event whose data is not a
 * JSON object (an array, a bare string, nothing at all) carries no fields for a
 * trigger to route on, so it is treated as an empty payload.
 */
function toTriggerPayload(value: unknown): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

// The return type is stated because declaration emit cannot name the inferred
// one: it references types inngest keeps internal (`SendSignalResponse` under
// inngest/api). `InngestFunction.Any` is what `getInngestFunctions` collects
// these into anyway.
export function createInngestEventListenerFunction(input: {
  id: string;
  workflowId: string;
  inngestEventTrigger: InngestEventTriggerConfig;
}): InngestFunction.Any {
  const { eventNames, functionOptions } = input.inngestEventTrigger;
  const eventLabel = eventNames.join(", ");

  return getInngestClient().createFunction(
    {
      ...functionOptions,
      id: input.id,
      name: `Event listener: ${eventLabel}`,
      // These names come from whoever registered the trigger, so there is no
      // schema to attach and `event.data` stays unknown until
      // `toTriggerPayload` narrows it.
      triggers: eventNames.map((name) => ({ event: name })),
    },
    async ({ event }) => {
      const payload = toTriggerPayload(event.data);

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

      const routing = routeWorkflowTrigger({
        config: triggerConfig,
        payload,
        eventName: event.name,
      });
      const { eventType, correlationKey, action } = routing;

      requestLogger.info("Event trigger received", {
        workflowName: workflow.name,
        runMode: workflow.mode,
        eventType,
        correlationKey,
        action,
        payloadKeys: Object.keys(payload),
      });

      await logWorkflowAuditEvent({
        workflowId: input.workflowId,
        eventType: "trigger_received",
        message: `Event received: ${eventLabel}${eventType ? ` (${eventType})` : ""}`,
        metadata: { eventType, correlationKey, runMode: workflow.mode },
      });

      const outcome = await orchestrateRoutedTrigger({
        workflowId: input.workflowId,
        runMode: workflow.mode,
        routing,
        sourceNoun: "event",
        enableResumes: true,
        logger: eventListenerLogger,
        startExecution: async () =>
          await startWorkflowRun({
            workflow: {
              id: input.workflowId,
              name: workflow.name,
              graph: workflowGraph,
            },
            trigger: { type: "event", eventType, correlationKey },
            payload,
            runMode: workflow.mode,
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
