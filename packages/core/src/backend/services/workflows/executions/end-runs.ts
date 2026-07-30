/**
 * Ending a run from outside it, which happens two ways and in two orders.
 *
 * A cancel decides and then acts: the signal goes out, the row flips behind a
 * compare-and-set, and a run that finished first keeps its own terminal status. A
 * supersede has already been decided -- `ExecutionRepo.startForEntity` flips those
 * rows inside the lock that made room for the newer start -- so all that is left
 * is telling the runs to stop and saying why on their timelines.
 *
 * Either way a run can outlive the attempt: a signal that does not land leaves it
 * live against a terminal row, and both halves below report the ids that happened
 * to.
 */

import { Effect } from "effect";
import { partition, uniq } from "es-toolkit";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { getAppLogger } from "#src/backend/lib/logger";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo/index";

const logger = getAppLogger("workflow", "run-ending");

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
  eventName?: string;
};

export type EndedRunsSummary = {
  /** The runs this call ended, which are the runs an event no longer reaches. */
  endedExecutionIds: string[];
  /** The runs no signal reached, which may still be live against a dead row. */
  failedExecutionIds: string[];
};

/**
 * How ending one run went. A run either reaches its terminal write, loses the
 * race to a completion that beat this call there, or is left unreachable by a
 * signal or a write that did not land -- the three outcomes `endOneRun` can
 * report, as a union rather than a `{ ended, failed }` pair that could also
 * spell the fourth, impossible combination.
 */
type RunEndOutcome =
  | { kind: "ended"; executionId: string }
  | { kind: "lost-race"; executionId: string }
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
const signalRunToStop = Effect.fn("signalRunToStop")(function* (input: {
  workflowId: string;
  executionId: string;
  reason: string;
  eventName?: string;
}) {
  const inngest = yield* InngestClient;

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
          logger.error("Failed to send cancel signal for execution", {
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
  eventName?: string;
  outcome: "send_failed" | "write_failed";
}) {
  const repo = yield* ExecutionRepo;

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
        Effect.sync(() => {
          logger.error("Failed to record a half-failed ending", {
            workflowId: input.workflowId,
            executionId: input.executionId,
            outcome: input.outcome,
            error: auditError,
          });
        })
      )
    );
});

const recordRunEnded = Effect.fn("recordRunEnded")(function* (input: {
  workflowId: string;
  executionId: string;
  eventType: "run_cancelled" | "run_superseded";
  reason: string;
  eventName?: string;
}) {
  const repo = yield* ExecutionRepo;

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
        Effect.sync(() => {
          logger.error("Failed to record the end of an execution", {
            workflowId: input.workflowId,
            executionId: input.executionId,
            eventName: input.eventName,
            error,
          });
          return false;
        })
      )
    );
});

/**
 * Cancels every in-flight execution named: signal first, then the row behind a
 * compare-and-set.
 *
 * An execution that completed between the caller's candidate query and this write
 * loses nothing: the CAS fails, the row keeps its terminal status, no audit event
 * is written, and the run is not counted as ended. Its wait row is still cleaned,
 * because a prior partly-failed attempt can leave a terminal execution with a
 * still-waiting row and this is the path that heals it (`cancelWaits` guards on
 * `waiting`, so a legitimately resumed wait is untouched).
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

  const [unreachable, settled] = partition(
    outcomes,
    (entry) => entry.kind === "unreachable"
  );

  yield* repo.cancelWaits(
    waitStateIdsFor(
      input.waitStates,
      settled.map((entry) => entry.executionId)
    )
  );

  const summary: EndedRunsSummary = {
    endedExecutionIds: settled
      .filter((entry) => entry.kind === "ended")
      .map((entry) => entry.executionId),
    failedExecutionIds: unreachable.map((entry) => entry.executionId),
  };
  return summary;
});

const endOneRun = Effect.fn("endOneRun")(function* (input: {
  workflowId: string;
  executionId: string;
  reason: string;
  eventName?: string;
}) {
  const { executionId, workflowId } = input;
  const repo = yield* ExecutionRepo;

  const signalled = yield* signalRunToStop({
    workflowId,
    executionId,
    reason: input.reason,
    eventName: input.eventName,
  });
  if (!signalled) {
    return runEndOutcome("unreachable", executionId);
  }

  const wasInFlight = yield* repo
    .endInFlight({
      executionId,
      status: "canceled",
      error: input.reason,
    })
    .pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          logger.error("Failed to end an execution", {
            workflowId,
            executionId,
            error,
          });
          yield* recordEndingFailure({
            workflowId,
            executionId,
            message: `${input.reason}: the run was told to stop, but its status could not be written`,
            eventName: input.eventName,
            outcome: "write_failed",
          });
          return null;
        })
      )
    );

  if (wasInFlight === null) {
    return runEndOutcome("unreachable", executionId);
  }

  if (!wasInFlight) {
    logger.info(
      "Execution reached a terminal status before it could be ended",
      {
        workflowId,
        executionId,
      }
    );
    return runEndOutcome("lost-race", executionId);
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
 * Tells the runs a newer start displaced to stop, and records what ended them.
 *
 * Their execution rows and wait rows were both flipped inside the lock that made
 * room for the newer start, so there is no compare-and-set here and no wait row to
 * clean: this is the announcement half of a decision already made.
 */
export const announceSupersededRuns = Effect.fn("announceSupersededRuns")(
  function* (input: {
    workflowId: string;
    executionIds: string[];
    reason: string;
    eventName?: string;
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
            eventType: "run_superseded",
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
  }
);

function waitStateIdsFor(
  waitStates: EndingWaitState[],
  executionIds: string[]
): string[] {
  const ended = new Set(executionIds);
  return waitStates
    .filter((state) => ended.has(state.executionId))
    .map((state) => state.id);
}
