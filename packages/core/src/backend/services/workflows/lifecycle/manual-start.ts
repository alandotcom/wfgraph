import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { seamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { startWithConcurrency } from "#src/backend/services/workflows/lifecycle/concurrency";
import { loadWorkflowForRun } from "#src/backend/services/executions/preflight";
import {
  buildIgnoredRunAuditMessage,
  recordPausedRunIgnored,
} from "#src/backend/services/executions/run-rows";
import {
  type ExtensionCatalog,
  findEvent,
} from "@rova/shared/extensions/catalog";
import type { JsonObject } from "@rova/shared/types/json";
import { asNonEmptyString } from "@rova/shared/types/string";
import { getValueByPath } from "@rova/shared/utils/object-path";
import type { WorkflowExecuteResponse } from "@rova/shared/workflow/execution-contracts";
import {
  emptyLifecycleRules,
  type LifecycleRules,
  manualStartAllowed,
  resolveCorrelationPath,
} from "@rova/shared/workflow/lifecycle-rules";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("workflow", "manual-start").with({ workflowId })
  );

/**
 * Which entity a manual run is about.
 *
 * A manual run stands in for an Event, so it is about whatever its payload is
 * about: the Start Event's Correlation Path is read against the body and the value
 * found there is the entity. That is what makes a test run supersede the run it is
 * testing rather than sit beside it.
 *
 * A payload carrying none falls back to the workflow itself (CONTEXT.md), and the
 * fallback is namespaced because this entity space is shared with values a sender
 * controls: a bare id would let a payload claim to be the workflow's own entity.
 */
function readManualEntityValue(input: {
  workflowId: string;
  rules: LifecycleRules;
  payload: JsonObject;
  catalog: ExtensionCatalog;
}): string {
  const { catalog } = input;
  const fallback = `workflow:${input.workflowId}`;

  const eventName = input.rules.startEvent;
  if (!eventName) {
    return fallback;
  }

  const path = resolveCorrelationPath({
    rules: input.rules,
    eventName,
    declaredPath: findEvent(catalog, eventName)?.correlationPath,
  });
  if (!path) {
    return fallback;
  }

  return asNonEmptyString(getValueByPath(input.payload, path)) ?? fallback;
}

/**
 * A manual run: the Run button, and the one entrypoint that names a workflow
 * rather than an Event.
 */
export const postWorkflowExecute = Effect.fn("postWorkflowExecute")(
  function* (
    workflowId: string,
    body: {
      /**
       * The manual-run payload. It stands in for an Event payload, follows the
       * same path onto the Inngest event and into the JSONB
       * `workflow_executions.input` column, and so carries the same JSON-only
       * contract.
       */
      input?: JsonObject;
    }
  ) {
    const logger = yield* loggerFor(workflowId);

    const { workflow, preflight } = yield* loadWorkflowForRun(workflowId).pipe(
      Effect.tapError((failure) =>
        "error" in failure
          ? logger.error("Refused a manual run", { error: failure.error })
          : Effect.void
      )
    );

    const payload = body.input ?? {};
    const runMode = workflow.mode;
    const rules = preflight.lifecycleRules ?? emptyLifecycleRules;

    if (workflow.isPaused) {
      const ignoredExecution = yield* recordPausedRunIgnored({
        workflowId,
        startSource: "manual",
        runMode,
        payload,
      });

      const response: WorkflowExecuteResponse = {
        status: "ignored",
        executionId: ignoredExecution.id,
        runMode,
        reason: "workflow_paused",
      };
      return response;
    }

    if (!manualStartAllowed(preflight.lifecycleRules)) {
      yield* logger.info("Refused a manual run", {
        reason: "manual_start_not_allowed",
      });

      // A Refused Start, recorded the way the other two are: this one is the
      // workflow's own checkbox declining, and the panel that lists refusals has
      // to hold for the case a builder created themselves.
      const repo = yield* ExecutionRepo;
      yield* repo.recordAuditEvent({
        workflowId,
        eventType: "run_not_started",
        message: buildIgnoredRunAuditMessage({
          startSource: "manual",
          reason: "manual_start_not_allowed",
        }),
        metadata: {
          reason: "manual_start_not_allowed",
          startSource: "manual",
          runMode,
        },
      });

      const response: WorkflowExecuteResponse = {
        status: "ignored",
        runMode,
        reason: "manual_start_not_allowed",
      };
      return response;
    }

    yield* logger.info("Workflow execute request received", {
      workflowName: workflow.name,
      runMode,
      payloadKeys: Object.keys(payload),
    });

    const started = yield* startWithConcurrency({
      workflow: {
        id: workflowId,
        name: workflow.name,
        graph: preflight.workflowGraph,
      },
      concurrency: rules.concurrency,
      start: {
        source: "manual",
        entityValue: readManualEntityValue({
          workflowId,
          rules,
          payload,
          catalog: (yield* Extensions).catalog,
        }),
      },
      runMode,
      payload,
      logger,
    });

    if (started.status === "not_started") {
      // No execution id: the refusal wrote no run, and the run it deferred to
      // belongs to whoever started it. The timeline carries the refusal.
      const response: WorkflowExecuteResponse = {
        status: "ignored",
        runMode,
        reason: started.reason,
      };
      return response;
    }

    const response: WorkflowExecuteResponse = {
      status: "running",
      executionId: started.executionId,
      runId: started.runId,
      runMode,
      ...(started.supersededExecutionIds.length > 0
        ? { supersededExecutions: started.supersededExecutionIds.length }
        : {}),
      ...(started.failedToSupersede.length > 0
        ? { failedToSupersede: started.failedToSupersede }
        : {}),
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
