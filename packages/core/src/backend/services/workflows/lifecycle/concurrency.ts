/**
 * Concurrency: how many Executions may exist per Entity Value.
 *
 * A start always starts, and this is what decides what happens to the runs
 * already going (ADR-0007). Two of the three answers have to be recorded:
 * newest-wins ends the displaced run with a status, and first-wins refuses a
 * start and says so in run history.
 *
 * The decision itself is one locked transaction in `ExecutionRepo.startForEntity`,
 * because a candidate read followed by an insert is not a decision two arrivals
 * can share. The same transaction schedules the new run on the executor and
 * writes its "run started" entry. What is left here follows that transaction:
 * write the timelines of the runs it displaced.
 */

import { Effect } from "effect";
import type { EffectLogger } from "#src/backend/lib/effect/app-logger";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import { announceSupersededRuns } from "#src/backend/services/executions/end-runs";
import type { NewExecution } from "#src/backend/services/executions/repo";
import {
  recordStartRefusal,
  runStartedEntry,
  startAdmissionDecisionId,
  type WorkflowRunStart,
  type WorkflowRunTarget,
} from "#src/backend/services/executions/run-rows";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { Concurrency } from "@wfgraph/shared/lifecycle/lifecycle-rules";
import type { WorkflowMode } from "@wfgraph/shared/graph/types";
import type { EntityEligibilityReason } from "@wfgraph/shared/lifecycle/execution-contracts";

export type StartWithConcurrencyInput = {
  workflow: WorkflowRunTarget;
  concurrency: Concurrency;
  start: WorkflowRunStart;
  runMode: WorkflowMode;
  payload: JsonObject;
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
  | "entity_value_missing"
  | EntityEligibilityReason;

/**
 * What a start attempt did.
 *
 * `supersededExecutionIds` carries ids rather than a count because those runs are
 * ending, so the caller knows not to deliver the same Event to their waits.
 * `failedToSupersede` names the runs whose supersede the database refused to
 * record on their timelines, which is what stops a half-recorded supersede
 * reading as one clean new run.
 */
export type StartOutcome =
  | {
      status: "started";
      executionId: string;
      supersededExecutionIds: string[];
      failedToSupersede: string[];
    }
  | {
      status: "not_started";
      reason: StartRefusalReason;
      inFlightExecutionIds: string[];
    };

export const startWithConcurrency = Effect.fn(
  "wfgraph.execution.start_with_concurrency"
)(function* (input: StartWithConcurrencyInput) {
  const { workflow, start, runMode, payload, logger } = input;
  const driver = yield* ExecutionDriver;

  if (
    input.concurrency !== "unlimited" &&
    start.entityValue === undefined &&
    start.entityType === undefined
  ) {
    return yield* refuseStart({
      workflow,
      start,
      runMode,
      logger,
      reason: "entity_value_missing",
      inFlightExecutionIds: [],
    });
  }

  const executionIdentity =
    start.entityType === undefined
      ? { entityValue: start.entityValue }
      : { entityType: start.entityType, entityId: start.entityId };
  const execution: NewExecution = {
    workflowId: workflow.id,
    workflowVersionId: workflow.versionId,
    startSource: start.source,
    runMode,
    startEventName: start.eventName,
    input: payload,
    deliveryId: start.deliveryId,
    ...executionIdentity,
  };
  const opened = yield* driver.startRun({
    execution,
    concurrency: input.concurrency,
    supersededReason: supersededReason(start.eventName),
    admissionDecisionId:
      start.source === "event" && start.entityType && start.deliveryId
        ? startAdmissionDecisionId(workflow.id, start.deliveryId)
        : undefined,
    startedEntry: yield* runStartedEntry(execution),
  });

  if (opened.status === "admission_refused") {
    return {
      status: "not_started" as const,
      reason: opened.reason,
      inFlightExecutionIds: [],
    };
  }

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

  // The displaced rows already say `superseded` and lost their schedule rows
  // in the same transaction, so what is left is putting the reason on their
  // timelines. The ids whose entry the database refused travel back to the
  // caller.
  const announced =
    opened.supersededExecutionIds.length > 0
      ? yield* announceSupersededRuns({
          workflowId: workflow.id,
          executionIds: opened.supersededExecutionIds,
          reason: supersededReason(start.eventName),
          eventName: start.eventName,
        })
      : { failedExecutionIds: [] as string[] };

  const outcome: StartOutcome = {
    status: "started",
    executionId: opened.execution.id,
    supersededExecutionIds: opened.supersededExecutionIds,
    failedToSupersede: announced.failedExecutionIds,
  };
  return outcome;
});

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
  yield* recordStartRefusal({
    workflowId: input.workflow.id,
    startSource: input.start.source,
    reason: input.reason,
    runMode: input.runMode,
    logger: input.logger,
    eventName: input.start.eventName,
    entityValue: input.start.entityValue,
    deliveryId: input.start.deliveryId,
    extra: { inFlightExecutionIds: input.inFlightExecutionIds },
  });

  const outcome: StartOutcome = {
    status: "not_started",
    reason: input.reason,
    inFlightExecutionIds: input.inFlightExecutionIds,
  };
  return outcome;
});
