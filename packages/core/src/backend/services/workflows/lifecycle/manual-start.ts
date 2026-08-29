import { Effect } from "effect";
import {
  AppLogger,
  type EffectLogger,
} from "#src/backend/lib/effect/app-logger";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { InvalidInput } from "#src/backend/lib/effect/failures";
import { seamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import { startWithConcurrency } from "#src/backend/services/workflows/lifecycle/concurrency";
import {
  loadDraftForRun,
  loadWorkflowForRun,
} from "#src/backend/services/executions/preflight";
import {
  buildIgnoredRunAuditMessage,
  recordPausedRunIgnored,
  toWorkflowRunTarget,
} from "#src/backend/services/executions/run-rows";
import {
  type ExtensionCatalog,
  findEvent,
} from "@wfgraph/shared/extensions/catalog";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { asNonEmptyString } from "@wfgraph/shared/types/string";
import { getValueByPath } from "@wfgraph/shared/utils/object-path";
import type {
  WorkflowExecuteResponse,
  WorkflowExecutionIgnoredReason,
} from "@wfgraph/shared/lifecycle/execution-contracts";
import type { WorkflowMode } from "@wfgraph/shared/graph/types";
import {
  emptyLifecycleRules,
  type LifecycleRules,
  manualStartAllowed,
  resolveCorrelationPath,
  unknownEventMessage,
} from "@wfgraph/shared/lifecycle/lifecycle-rules";

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("manual-start").with({ workflowId })
  );

/**
 * Which entity a manual run is about.
 *
 * A manual run stands in for an Event, so it is about whatever its payload is
 * about: a Start Event's Correlation Path is read against the body and the value
 * found there is the entity. That is what makes a test run supersede the run it is
 * testing rather than sit beside it.
 *
 * A run naming its Event is read at that Event's path alone. One that names none
 * stands in for any of the Start Events, so their paths are tried in turn and the
 * first that finds a value wins. A payload answering none of them falls back to
 * the workflow itself (CONTEXT.md), and the fallback is namespaced because this
 * entity space is shared with values a sender controls: a bare id would let a
 * payload claim to be the workflow's own entity.
 */
function readManualEntityValue(input: {
  workflowId: string;
  rules: LifecycleRules;
  payload: JsonObject;
  catalog: ExtensionCatalog;
  eventName?: string;
}): string {
  const { catalog } = input;
  const candidates = input.eventName
    ? [input.eventName]
    : input.rules.startEvents;

  for (const eventName of candidates) {
    const path = resolveCorrelationPath({
      rules: input.rules,
      eventName,
      declaredPath: findEvent(catalog, eventName)?.correlationPath,
    });
    if (!path) {
      continue;
    }

    const value = asNonEmptyString(getValueByPath(input.payload, path));
    if (value) {
      return value;
    }
  }

  return `workflow:${input.workflowId}`;
}

/** The Start Events a workflow takes, as the refusal sentence lists them. */
function formatEventList(startEvents: readonly string[]): string {
  return startEvents.length > 0
    ? startEvents.map((name) => `"${name}"`).join(", ")
    : "none";
}

/**
 * A start this workflow does not take, recorded and answered.
 *
 * No Execution row, because no run began: the timeline carries the refusal, and
 * the response says which rule turned it away.
 */
const refuseManualStart = Effect.fn("refuseManualStart")(function* (input: {
  workflowId: string;
  runMode: WorkflowMode;
  reason: Extract<
    WorkflowExecutionIgnoredReason,
    "manual_start_not_allowed" | "start_event_required"
  >;
  logger: EffectLogger;
}) {
  const { workflowId, runMode, reason } = input;
  yield* input.logger.info("Refused a manual run", { reason });

  const repo = yield* ExecutionRepo;
  yield* repo.recordAuditEvent({
    workflowId,
    eventType: "run_refused",
    message: buildIgnoredRunAuditMessage({ startSource: "manual", reason }),
    metadata: { reason, startSource: "manual", runMode },
  });

  const response: WorkflowExecuteResponse = {
    status: "ignored",
    runMode,
    reason,
  };
  return response;
});

/**
 * A manual run: the Run button, and the one entrypoint that names a workflow
 * rather than an Event.
 */
export const postWorkflowExecute = Effect.fn("wfgraph.execution.start")(
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
      /**
       * The Start Event this run stands in for, which the engine routes an Event
       * Split on. Absent is the plain manual start, and the graphs it can travel
       * are the ones holding no such node.
       */
      eventName?: string;
      /**
       * Which graph this run travels. Absent is the published version, which is
       * what an Event start and a live workflow always get. `"draft"` runs what
       * the canvas holds, frozen into a snapshot version the run pins to, and is
       * refused unless the workflow is in test mode.
       */
      graph?: "published" | "draft";
    }
  ) {
    const logger = yield* loggerFor(workflowId);
    yield* annotateServiceSpan({ workflowId });

    // The two loads answer the same pair, so every gate below reads the same
    // way whichever graph the run is of.
    const source = body.graph ?? "published";
    const { workflow, preflight, pinVersion } = yield* (
      source === "draft"
        ? loadDraftForRun(workflowId)
        : loadWorkflowForRun(workflowId)
    ).pipe(
      Effect.tapError((failure) =>
        "error" in failure
          ? logger.error("Refused a manual run", { error: failure.error })
          : Effect.void
      )
    );

    const payload = body.input ?? {};
    const runMode = workflow.mode;
    const rules = preflight.lifecycleRules ?? emptyLifecycleRules;
    const extensions = yield* Extensions;
    const eventName = body.eventName;

    // The Event gate comes before every lifecycle question below, because a
    // request naming an Event this workflow does not take, or carrying a payload
    // that Event refuses, is malformed rather than declined. It leaves no row and
    // answers 400, which is the same verdict the Event listener reaches on the
    // delivery path.
    if (eventName) {
      if (!rules.startEvents.includes(eventName)) {
        return yield* new InvalidInput({
          error: `"${eventName}" does not start this workflow. Its Start Events are ${formatEventList(rules.startEvents)}.`,
        });
      }

      const definition = extensions.eventByName(eventName);
      if (!definition) {
        return yield* new InvalidInput({
          error: unknownEventMessage(eventName),
        });
      }

      const rejection = yield* definition.decodePayload(payload).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (rejected) => rejected,
        })
      );
      if (rejection) {
        // The sentence the caller reads names the Event; the operator's line
        // carries the detail, which quotes paths rather than values.
        yield* logger.info("Refused a manual run payload", {
          eventName,
          error: rejection.detail,
        });
        return yield* new InvalidInput({
          error: `Payload refused for Event "${eventName}": ${rejection.error}`,
        });
      }
    }

    if (workflow.isPaused) {
      yield* pinVersion;
      const ignoredExecution = yield* recordPausedRunIgnored({
        workflowId,
        workflowVersionId: preflight.workflowVersionId,
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
      return yield* refuseManualStart({
        workflowId,
        runMode,
        reason: "manual_start_not_allowed",
        logger,
      });
    }

    // A run with no Event leaves an Event Split by no outlet, so everything
    // behind the split would go unrun with nothing said. Refusing here is what
    // turns that silence into a line the builder can read.
    if (!eventName && preflight.hasEventSplit) {
      return yield* refuseManualStart({
        workflowId,
        runMode,
        reason: "start_event_required",
        logger,
      });
    }

    yield* logger.info("Workflow execute request received", {
      request: {
        workflowName: workflow.name,
        runMode,
        graph: source,
        eventName,
        payloadKeys: Object.keys(payload),
      },
    });

    // The two writes of `preflight.workflowVersionId` onto an Execution sit
    // here and in the paused branch, and the pin runs just ahead of each so a
    // start refused above left no version row behind.
    yield* pinVersion;
    const started = yield* startWithConcurrency({
      workflow: toWorkflowRunTarget({
        workflow: { id: workflowId, name: workflow.name },
        versionId: preflight.workflowVersionId,
        catalogFingerprint: preflight.catalogFingerprint,
        graph: preflight.workflowGraph,
      }),
      concurrency: rules.concurrency,
      start: {
        source: "manual",
        eventName,
        entityValue: readManualEntityValue({
          workflowId,
          rules,
          payload,
          catalog: extensions.catalog,
          eventName,
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
  // The start span's own verdict: how the request ended, and the run it opened
  // if it opened one. Read off the answer, so a span that ends without a failure
  // always names an outcome whichever of the five returns reached it.
  Effect.tap((response) =>
    annotateServiceSpan({
      executionId: response.executionId,
      outcome: response.status,
    })
  ),
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
