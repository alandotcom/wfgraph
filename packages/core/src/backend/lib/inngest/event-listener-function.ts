import { Effect } from "effect";
import type { InngestFunction } from "inngest";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import { callDbModule } from "#src/backend/lib/effect/database";
import { callInngestModule } from "#src/backend/lib/effect/inngest-client";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import { resumeMatchingWaitHooks } from "#src/backend/lib/workflow-wait-resume";
import type { RovaRuntime } from "#src/backend/runtime";
import { orchestrateRoutedTrigger } from "#src/backend/services/workflows/triggering/routing";
import { runWorkflowExecutionPreflight } from "#src/backend/services/workflows/triggering/preflight";
import { startWorkflowRun } from "#src/backend/services/workflows/triggering/run-lifecycle";
import { WorkflowRepo } from "#src/backend/services/workflows/repo";
import { type JsonObject, readJsonObject } from "@rova/shared/types/json";
import type { InngestEventTriggerConfig } from "@rova/shared/workflow/trigger-registry";
import { routeWorkflowTrigger } from "@rova/shared/workflow/trigger-registry";
import { getInngestClient } from "./client";

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
  return readJsonObject(value) ?? {};
}

/**
 * What this function answers Inngest with when the workflow behind it cannot
 * run. Neither is retryable, so both are values rather than throws.
 */
type EventListenerRefusal = {
  status: "error";
  reason: "workflow_not_found" | "preflight_failed";
};

const refusePreflight = (logger: EffectLogger, workflowName: string) =>
  logger
    .error("Event listener preflight failed", { workflowName })
    .pipe(Effect.as(undefined));

/**
 * One delivered event, from the workflow lookup through to the outcome.
 *
 * The two refusals become return values here because Inngest retries a throw,
 * and neither a missing workflow nor a graph that will not validate improves on
 * a second attempt. A rejected query or a refused send does still fail, which is
 * what puts the event back in front of the retry policy.
 */
export const runEventTrigger = Effect.fn("runEventTrigger")(function* (input: {
  workflowId: string;
  eventLabel: string;
  eventNames: string[];
  eventName: string;
  payload: JsonObject;
}) {
  const { workflowId, eventLabel, payload } = input;
  const repo = yield* WorkflowRepo;
  const logger = (yield* AppLogger)
    .get("workflow", "event-listener")
    .with({ workflowId, inngestEventNames: input.eventNames });

  const workflow = yield* repo.findById(workflowId);

  if (!workflow) {
    yield* logger.error("Workflow not found for event listener");
    const refusal: EventListenerRefusal = {
      status: "error",
      reason: "workflow_not_found",
    };
    return refusal;
  }

  const preflight = yield* runWorkflowExecutionPreflight({
    workflow,
    logger,
    requireExecutionType: "event",
  }).pipe(
    // Only the two verdicts preflight reaches on its own are turned into a
    // refusal. A rejected query underneath it is not a verdict, and is left to
    // fail so the event is retried.
    Effect.catchTags({
      InvalidInput: () => refusePreflight(logger, workflow.name),
      IntegrationValidationFailed: () => refusePreflight(logger, workflow.name),
    })
  );

  if (!preflight) {
    const refusal: EventListenerRefusal = {
      status: "error",
      reason: "preflight_failed",
    };
    return refusal;
  }

  const { workflowGraph, triggerConfig } = preflight;

  if (workflow.isPaused) {
    yield* callDbModule(() =>
      logWorkflowAuditEvent({
        workflowId,
        eventType: "run_ignored",
        message: "Ignored event because workflow is paused",
        metadata: { inngestEventName: eventLabel, runMode: workflow.mode },
      })
    );
    return { status: "ignored", reason: "workflow_paused" } as const;
  }

  const routing = routeWorkflowTrigger({
    config: triggerConfig,
    payload,
    eventName: input.eventName,
  });
  const { eventType, correlationKey, action } = routing;

  yield* logger.info("Event trigger received", {
    workflowName: workflow.name,
    runMode: workflow.mode,
    eventType,
    correlationKey,
    action,
    payloadKeys: Object.keys(payload),
  });

  yield* callDbModule(() =>
    logWorkflowAuditEvent({
      workflowId,
      eventType: "trigger_received",
      message: `Event received: ${eventLabel}${eventType ? ` (${eventType})` : ""}`,
      metadata: { eventType, correlationKey, runMode: workflow.mode },
    })
  );

  const outcome = yield* orchestrateRoutedTrigger({
    workflowId,
    runMode: workflow.mode,
    routing,
    sourceNoun: "event",
    logger,
    startExecution: () =>
      startWorkflowRun({
        workflow: {
          id: workflowId,
          name: workflow.name,
          graph: workflowGraph,
        },
        trigger: { type: "event", eventType, correlationKey },
        payload,
        runMode: workflow.mode,
      }),
    resumeWaitStates: (currentEventType, waitStates) =>
      callInngestModule(() =>
        resumeMatchingWaitHooks({
          workflowId,
          eventType: currentEventType,
          payload,
          waitStates,
        })
      ),
  });

  if (outcome.status === "ignored") {
    yield* callDbModule(() =>
      logWorkflowAuditEvent({
        workflowId,
        eventType: "run_ignored",
        message: `Ignored event ${eventLabel}${eventType ? ` (${eventType})` : ""}`,
        metadata: {
          eventType,
          correlationKey,
          reason: outcome.reason,
          runMode: workflow.mode,
        },
      })
    );
  }

  return outcome;
});

// The return type is stated because declaration emit cannot name the inferred
// one: it references types inngest keeps internal (`SendSignalResponse` under
// inngest/api). `InngestFunction.Any` is what `getInngestFunctions` collects
// these into anyway.
export function createInngestEventListenerFunction(input: {
  id: string;
  workflowId: string;
  inngestEventTrigger: InngestEventTriggerConfig;
  /**
   * The app's Layer graph. It arrives from `createRovaApp` through the function
   * registry rather than being reached for here, so this function runs its
   * services on the same repositories and logger the HTTP side does.
   */
  runtime: RovaRuntime;
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
    async ({ event }) =>
      await input.runtime.runPromise(
        runEventTrigger({
          workflowId: input.workflowId,
          eventLabel,
          eventNames,
          eventName: event.name,
          payload: toTriggerPayload(event.data),
        })
      )
  );
}
