/**
 * Ending a run from outside it, which happens two ways and in two orders.
 *
 * A cancel decides and then acts: the row flips behind a compare-and-set, then
 * the signal goes out, and a run that finished or claimed termination first keeps
 * its own outcome. A supersede has already been decided --
 * `ExecutionRepo.startForEntity` flips those
 * rows inside the lock that made room for the newer start -- so all that is left
 * is telling the runs to stop and saying why on their timelines.
 *
 * Either way a run can outlive the attempt: a signal that does not land leaves it
 * live against a terminal row, and both halves below report the ids that happened
 * to.
 */

import { Effect } from "effect";
import { groupBy, uniq } from "es-toolkit/array";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

/** This module's logger, as the Effect that produces it (see `list.ts`). */
const loggerFor = Effect.map(AppLogger, (appLogger) =>
  appLogger.get("run-ending")
);

/** A wait row belonging to a run being ended, which is cancelled with it. */
type EndingWaitState = {
  id: string;
  executionId: string;
};

export type CancelInFlightRunsInput = {
  workflowId: string;
  /** Every in-flight execution to end, whatever node each is standing on. */
  executionIds: string[];
  /** Wait states belonging to the waiting subset of those executions. */
  waitStates: EndingWaitState[];
  reason: string;
  eventName?: string | undefined;
};

export type EndedRunsSummary = {
  /** The runs this call ended, which are the runs an event no longer reaches. */
  endedExecutionIds: string[];
  /** The runs no signal reached, which may still be live against a dead row. */
  failedExecutionIds: string[];
  /**
   * The runs an earlier Cancel or Exit claim already owns. Each is still in
   * flight, walking the Canceled outlet or on its way to an `exited` row, and
   * its own durable run is what ends it. Separate from `failedExecutionIds`
   * because nothing here went wrong.
   */
  claimedExecutionIds: string[];
};

/**
 * How ending one run went. A run can reach its terminal write, lose to a
 * terminal result, remain owned by an earlier termination claim, or be left
 * unreachable by a signal or write failure. The union prevents contradictory
 * outcome combinations.
 */
type RunEndOutcome =
  | { kind: "ended"; executionId: string }
  | { kind: "lost-race"; executionId: string }
  | { kind: "claim-pending"; executionId: string }
  | { kind: "unreachable"; executionId: string };

function runEndOutcome(
  kind: RunEndOutcome["kind"],
  executionId: string
): RunEndOutcome {
  return { kind, executionId };
}

/**
 * Sends one run's cancel signal, and says on its timeline when the send failed.
 *
 * Each workflow function's `cancelOn` stops the run between steps and interrupts
 * sleeps and waits; a step already executing runs to completion, which is why
 * every completion write carries its own terminal-status guard. The signal for a
 * run that has already finished is a no-op at Inngest.
 */
export const signalRunToStop = Effect.fn("signalRunToStop")(function* (input: {
  workflowId: string;
  executionId: string;
  reason: string;
  eventName?: string | undefined;
}) {
  const inngest = yield* InngestClient;
  const logger = yield* loggerFor;

  return yield* inngest
    .sendCancelRequested({
      executionId: input.executionId,
      workflowId: input.workflowId,
      reason: input.reason,
      requestedBy: input.workflowId,
      eventType: input.eventName,
    })
    .pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* logger.error("Failed to send cancel signal for execution", {
            workflowId: input.workflowId,
            executionId: input.executionId,
            eventName: input.eventName,
            error,
          });

          yield* recordEndingFailure({
            workflowId: input.workflowId,
            executionId: input.executionId,
            message: `${input.reason}: the cancel signal failed to send, so the run may still be live`,
            eventName: input.eventName,
            outcome: "send_failed",
          });

          return false;
        })
      )
    );
});

/**
 * Says on a run's timeline that an ending went half-through.
 *
 * The run survives either half-failure, so without this row a run left live
 * against a stale status reads as a healthy one. The write itself is allowed to
 * fail: a `write_failed` outcome means the database just refused a write, and the
 * log line is what an operator has left in that case.
 */
const recordEndingFailure = Effect.fn("recordEndingFailure")(function* (input: {
  workflowId: string;
  executionId: string;
  message: string;
  eventName?: string | undefined;
  outcome: "send_failed" | "write_failed";
}) {
  const repo = yield* ExecutionRepo;
  const logger = yield* loggerFor;

  yield* repo
    .recordAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: "run_cancel_requested",
      message: input.message,
      metadata: { eventName: input.eventName, outcome: input.outcome },
    })
    .pipe(
      Effect.catch((auditError) =>
        logger.error("Failed to record a half-failed ending", {
          workflowId: input.workflowId,
          executionId: input.executionId,
          outcome: input.outcome,
          error: auditError,
        })
      )
    );
});

const recordRunEnded = Effect.fn("recordRunEnded")(function* (input: {
  workflowId: string;
  executionId: string;
  eventType: "run_cancelled" | "run_superseded" | "run_failed";
  reason: string;
  eventName?: string | undefined;
}) {
  const repo = yield* ExecutionRepo;
  const logger = yield* loggerFor;

  return yield* repo
    .recordAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: input.eventType,
      message: input.reason,
      metadata: { eventName: input.eventName },
    })
    .pipe(
      Effect.as(true),
      Effect.catch((error) =>
        logger
          .error("Failed to record the end of an execution", {
            workflowId: input.workflowId,
            executionId: input.executionId,
            eventName: input.eventName,
            error,
          })
          .pipe(Effect.as(false))
      )
    );
});

/**
 * Cancels every in-flight execution named: claim the terminal row behind a
 * compare-and-set, then signal the run this call ended. A repeated request also
 * repairs a canceled row whose earlier signal or audit failed.
 *
 * An execution that completed between the caller's candidate query and this write
 * loses nothing: the CAS fails, the row keeps its terminal status, no audit event
 * is written, and the run is not counted as ended. Its wait row is still cleaned,
 * because a prior partly-failed attempt can leave a terminal execution with a
 * still-waiting row and this is the path that heals it (`cancelWaits` guards on
 * `waiting`, so a legitimately resumed wait is untouched). An in-flight Cancel
 * or Exit claim remains owned by its durable run; this call neither signals that
 * run nor cleans its waits.
 *
 * Every failure is contained per execution, so one of them never discards the
 * summary or skips the cleanup for the executions that did end.
 */
export const cancelInFlightRuns = Effect.fn("cancelInFlightRuns")(function* (
  input: CancelInFlightRunsInput
) {
  const repo = yield* ExecutionRepo;

  const outcomes = yield* Effect.forEach(
    uniq(input.executionIds),
    (executionId) =>
      endOneRun({
        workflowId: input.workflowId,
        executionId,
        reason: input.reason,
        eventName: input.eventName,
      }),
    { concurrency: "unbounded" }
  );

  const byKind = groupBy(outcomes, (entry) => entry.kind);
  const executionIdsOf = (kind: RunEndOutcome["kind"]) =>
    (byKind[kind] ?? []).map((entry) => entry.executionId);

  // A run this call ended and a run that reached a terminal status first are
  // both over, so both have their wait rows cleaned. The two that are not are a
  // run the signal never reached and a run another claim still owns.
  yield* repo.cancelWaits(
    waitStateIdsFor(input.waitStates, [
      ...executionIdsOf("ended"),
      ...executionIdsOf("lost-race"),
    ])
  );

  const summary: EndedRunsSummary = {
    endedExecutionIds: executionIdsOf("ended"),
    failedExecutionIds: executionIdsOf("unreachable"),
    claimedExecutionIds: executionIdsOf("claim-pending"),
  };
  return summary;
});

const endOneRun = Effect.fn("endOneRun")(function* (input: {
  workflowId: string;
  executionId: string;
  reason: string;
  eventName?: string | undefined;
}) {
  const { executionId, workflowId } = input;
  const repo = yield* ExecutionRepo;
  const logger = yield* loggerFor;

  const termination = yield* repo
    .endInFlight({
      executionId,
      status: "canceled",
      error: input.reason,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* logger.error("Failed to end an execution", {
            workflowId,
            executionId,
            error,
          });
          yield* recordEndingFailure({
            workflowId,
            executionId,
            message: `${input.reason}: the status could not be written, so no cancel signal was sent`,
            eventName: input.eventName,
            outcome: "write_failed",
          });
          return null;
        })
      )
    );

  if (termination === null) {
    return runEndOutcome("unreachable", executionId);
  }

  if (!termination.didWrite) {
    if (
      termination.claim &&
      IN_FLIGHT_EXECUTION_STATUSES.some(
        (status) => status === termination.status
      )
    ) {
      yield* logger.info("Execution already has a termination claim", {
        workflowId,
        executionId,
        claim: termination.claim.kind,
      });
      return runEndOutcome("claim-pending", executionId);
    }

    if (termination.status !== "canceled") {
      yield* logger.info(
        "Execution reached a terminal status before it could be ended",
        {
          workflowId,
          executionId,
        }
      );
      return runEndOutcome("lost-race", executionId);
    }
  }

  const signalled = yield* signalRunToStop({
    workflowId,
    executionId,
    reason: input.reason,
    eventName: input.eventName,
  });
  if (!signalled) {
    return runEndOutcome("unreachable", executionId);
  }

  const recorded = yield* recordRunEnded({
    workflowId,
    executionId,
    eventType: "run_cancelled",
    reason: input.reason,
    eventName: input.eventName,
  });
  return runEndOutcome(recorded ? "ended" : "unreachable", executionId);
});

/**
 * Tells runs whose rows a serialized start already flipped to stop, and records what
 * ended them.
 *
 * Those rows and their wait rows were both written inside the lock that made room
 * for the newer start, so there is no compare-and-set here and no wait row to
 * clean: this is the announcement half of a decision already made.
 */
const announceEndedRuns = Effect.fn("announceEndedRuns")(function* (input: {
  workflowId: string;
  executionIds: string[];
  eventType: "run_superseded" | "run_failed";
  reason: string;
  eventName?: string | undefined;
}) {
  const outcomes = yield* Effect.forEach(
    uniq(input.executionIds),
    (executionId) =>
      Effect.gen(function* () {
        const signalled = yield* signalRunToStop({
          workflowId: input.workflowId,
          executionId,
          reason: input.reason,
          eventName: input.eventName,
        });
        const recorded = yield* recordRunEnded({
          workflowId: input.workflowId,
          executionId,
          eventType: input.eventType,
          reason: input.reason,
          eventName: input.eventName,
        });

        return { executionId, failed: !(signalled && recorded) };
      }),
    { concurrency: "unbounded" }
  );

  return {
    failedExecutionIds: outcomes
      .filter((entry) => entry.failed)
      .map((entry) => entry.executionId),
  };
});

/** Announces the runs newest-wins Concurrency displaced. */
export const announceSupersededRuns = (input: {
  workflowId: string;
  executionIds: string[];
  reason: string;
  eventName?: string | undefined;
}) => announceEndedRuns({ ...input, eventType: "run_superseded" });

/**
 * Announces the runs a start found stuck between their row and the bus.
 *
 * The signal is what makes the row's `failed` status honest: the stamp those rows
 * are missing can also go missing on a run Inngest really did take, so a run that
 * turns out to be live is stopped rather than left executing against a row that
 * says it failed.
 */
export const announceReclaimedRuns = (input: {
  workflowId: string;
  executionIds: string[];
  reason: string;
  eventName?: string | undefined;
}) => announceEndedRuns({ ...input, eventType: "run_failed" });

function waitStateIdsFor(
  waitStates: EndingWaitState[],
  executionIds: string[]
): string[] {
  const ended = new Set(executionIds);
  return waitStates
    .filter((state) => ended.has(state.executionId))
    .map((state) => state.id);
}
