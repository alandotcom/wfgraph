/**
 * Concurrency: how many Executions may exist per Entity Value.
 *
 * A start always starts, and this is what decides what happens to the runs
 * already going (ADR-0007). Workflow Graph owns it rather than Inngest because two of the
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
import {
  announceReclaimedRuns,
  announceSupersededRuns,
} from "#src/backend/services/executions/end-runs";
import {
  ExecutionRepo,
  UNSENT_RUN_RECLAIM_REASON,
} from "#src/backend/services/executions/repo";
import {
  buildIgnoredRunAuditMessage,
  enqueueStartedRun,
  type WorkflowRunStart,
  type WorkflowRunTarget,
} from "#src/backend/services/executions/run-rows";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { Concurrency } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowMode } from "@wfgraph/shared/graph/types";

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
        workflowVersionId: workflow.versionId,
        startSource: start.source,
        runMode,
        startEventName: start.eventName,
        entityValue: start.entityValue,
        input: payload,
        deliveryId: start.deliveryId,
      },
      concurrency: input.concurrency,
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
    const announced =
      opened.supersededExecutionIds.length > 0
        ? yield* announceSupersededRuns({
            workflowId: workflow.id,
            executionIds: opened.supersededExecutionIds,
            reason: supersededReason(start.eventName),
            eventName: start.eventName,
          })
        : { failedExecutionIds: [] as string[] };

    // Rows a crash left between their commit and the send, which this start
    // closed to get past first-wins. Announced the same way, because the row now
    // says `failed` and only the signal can make that true of the run.
    if (opened.reclaimedExecutionIds.length > 0) {
      yield* logger.info("Closed runs that never reached the bus", {
        executionIds: opened.reclaimedExecutionIds,
      });

      yield* announceReclaimedRuns({
        workflowId: workflow.id,
        executionIds: opened.reclaimedExecutionIds,
        reason: UNSENT_RUN_RECLAIM_REASON,
        eventName: start.eventName,
      });
    }

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
  const repo = yield* ExecutionRepo;

  yield* repo.recordAuditEvent({
    workflowId: input.workflow.id,
    eventType: "run_refused",
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
  });

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
