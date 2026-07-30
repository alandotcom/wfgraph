/**
 * Concurrency: how many Executions may exist per Entity Value.
 *
 * A start always starts, and this is what decides what happens to the runs
 * already going (ADR-0007). Rova owns it rather than Inngest because two of the
 * three answers have to be recorded: newest-wins ends the displaced run with a
 * status, and first-wins refuses a start and says so in run history.
 *
 * The decision itself is one locked transaction in `ExecutionRepo.startForEntity`,
 * because a candidate read followed by an insert is not a decision two arrivals
 * can share. What is left here is what a transaction must not do: tell the bus,
 * and write the timeline.
 */

import { Effect } from "effect";
import type { EffectLogger } from "#src/backend/lib/effect/app-logger";
import { callDbModule } from "#src/backend/lib/effect/database";
import {
  asPromisePort,
  callInngestModule,
  InngestClient,
} from "#src/backend/lib/effect/inngest-client";
import { logWorkflowAuditEvent } from "#src/backend/lib/workflow-audit";
import { announceSupersededRuns } from "#src/backend/lib/workflow-cancellation";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo";
import {
  buildIgnoredRunAuditMessage,
  enqueueStartedRun,
  type WorkflowRunStart,
  type WorkflowRunTarget,
} from "#src/backend/services/workflows/triggering/run-lifecycle";
import type { JsonObject } from "@rova/shared/types/json";
import type { Concurrency } from "@rova/shared/workflow/lifecycle-rules";
import type { WorkflowMode } from "@rova/shared/workflow/types";

export type StartWithConcurrencyInput = {
  workflow: WorkflowRunTarget;
  concurrency: Concurrency;
  start: WorkflowRunStart;
  runMode: WorkflowMode;
  payload: JsonObject;
  requestPayload?: JsonObject;
  logger: EffectLogger;
};

/**
 * Why a start produced no run.
 *
 * `entity_value_missing` is a payload carrying nothing at the Correlation Path
 * while Concurrency compares. With no entity there is nothing to be one-at-a-time
 * about, and starting anyway would quietly drop the guarantee the workflow asked
 * for.
 */
export type StartRefusalReason =
  | "concurrency_first_wins"
  | "entity_value_missing";

/**
 * What a start attempt did.
 *
 * `supersededExecutionIds` carries ids rather than a count because those runs are
 * ending, so the caller knows not to deliver the same Event to their waits.
 * `failedToSupersede` names the runs no signal reached, which is what stops a
 * half-failed supersede reading as one clean new run.
 */
export type StartOutcome =
  | {
      status: "started";
      executionId: string;
      runId?: string;
      supersededExecutionIds: string[];
      failedToSupersede: string[];
    }
  | {
      status: "not_started";
      reason: StartRefusalReason;
      inFlightExecutionIds: string[];
    };

export const startWithConcurrency = Effect.fn("startWithConcurrency")(
  function* (input: StartWithConcurrencyInput) {
    const { workflow, start, runMode, payload, logger } = input;
    const repo = yield* ExecutionRepo;

    if (input.concurrency !== "unlimited" && !start.entityValue) {
      return yield* refuseStart({
        workflow,
        start,
        runMode,
        logger,
        reason: "entity_value_missing",
        inFlightExecutionIds: [],
      });
    }

    const opened = yield* repo.startForEntity({
      execution: {
        workflowId: workflow.id,
        startSource: start.source,
        runMode,
        triggerEventType: start.eventName,
        correlationKey: start.entityValue,
        input: payload,
      },
      concurrency: input.concurrency,
      entityValue: start.entityValue,
      supersededReason: supersededReason(start.eventName),
    });

    if (opened.status === "refused") {
      return yield* refuseStart({
        workflow,
        start,
        runMode,
        logger,
        reason: "concurrency_first_wins",
        inFlightExecutionIds: opened.inFlightExecutionIds,
      });
    }

    // The displaced rows already say `superseded`, so what is left is telling
    // those runs to stop and putting the reason on their timelines. A signal that
    // never lands leaves a live run against a superseded row, which is why the ids
    // it failed on travel back to the caller.
    const inngest = yield* InngestClient;
    const announced =
      opened.supersededExecutionIds.length > 0
        ? yield* callInngestModule(() =>
            announceSupersededRuns({
              requestCancel: asPromisePort(inngest.sendCancelRequested),
              workflowId: workflow.id,
              executionIds: opened.supersededExecutionIds,
              reason: supersededReason(start.eventName),
              eventName: start.eventName,
            })
          )
        : { failedExecutionIds: [] };

    const started = yield* enqueueStartedRun({
      workflow,
      start,
      runMode,
      payload,
      requestPayload: input.requestPayload,
      executionId: opened.execution.id,
    });

    const outcome: StartOutcome = {
      status: "started",
      executionId: started.executionId,
      runId: started.runId,
      supersededExecutionIds: opened.supersededExecutionIds,
      failedToSupersede: announced.failedExecutionIds,
    };
    return outcome;
  }
);

function supersededReason(eventName: string | undefined): string {
  return eventName
    ? `Superseded by a newer start from ${eventName}`
    : "Superseded by a newer start";
}

/**
 * A refusal, recorded.
 *
 * Without the row a refusal is invisible, which is the class of problem ADR-0007
 * exists to remove: a builder reading run history should find the start that was
 * declined and why, rather than an absence.
 */
const refuseStart = Effect.fn("refuseStart")(function* (input: {
  workflow: WorkflowRunTarget;
  start: WorkflowRunStart;
  runMode: WorkflowMode;
  logger: EffectLogger;
  reason: StartRefusalReason;
  inFlightExecutionIds: string[];
}) {
  yield* callDbModule(() =>
    logWorkflowAuditEvent({
      workflowId: input.workflow.id,
      eventType: "run_not_started",
      message: buildIgnoredRunAuditMessage({
        startSource: input.start.source,
        reason: input.reason,
        eventName: input.start.eventName,
      }),
      metadata: {
        reason: input.reason,
        startSource: input.start.source,
        eventName: input.start.eventName,
        entityValue: input.start.entityValue,
        deliveryId: input.start.deliveryId,
        inFlightExecutionIds: input.inFlightExecutionIds,
        runMode: input.runMode,
      },
    })
  );

  yield* input.logger.info("Start refused", {
    reason: input.reason,
    entityValue: input.start.entityValue,
    inFlightExecutionIds: input.inFlightExecutionIds,
  });

  const outcome: StartOutcome = {
    status: "not_started",
    reason: input.reason,
    inFlightExecutionIds: input.inFlightExecutionIds,
  };
  return outcome;
});
