/**
 * Canceling a run from outside it through `ExecutionRepo.cancelRun`: a run that
 * finished or claimed termination first keeps its own outcome.
 *
 * The terminal write carries the run's `run_cancelled` entry, cancels its open
 * wait rows and deletes its schedule row in its own transaction, so a pass
 * holding the run has its next fenced write refused with `LeaseLost`. A write
 * the database refuses is reported in the ids the cancel returns.
 */

import { Effect } from "effect";
import { groupBy, uniq } from "es-toolkit/array";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

/** This module's logger, as the Effect that produces it (see `list.ts`). */
const loggerFor = (workflowId: string) =>
  Effect.map(AppLogger, (appLogger) =>
    appLogger.get("run-ending").with({ workflowId })
  );

export type CancelInFlightRunsInput = {
  workflowId: string;
  /** Every in-flight execution to end, whatever node each is standing on. */
  executionIds: string[];
  reason: string;
  eventName?: string | undefined;
};

export type EndedRunsSummary = {
  /** The runs this call ended, which are the runs an event no longer reaches. */
  endedExecutionIds: string[];
  /** The runs this call could not end, which an operator reads in the log. */
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
 * unreachable by a refused write. The union prevents contradictory outcome
 * combinations.
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
 * Says on a run's timeline that its status could not be written.
 *
 * The run survives a refused terminal write, so without this row a run left
 * live after a cancel reads as a healthy one. The write itself is allowed to
 * fail, and the log line is what an operator has left in that case.
 */
const recordEndingFailure = Effect.fn("recordEndingFailure")(function* (input: {
  workflowId: string;
  executionId: string;
  message: string;
  eventName?: string | undefined;
}) {
  const repo = yield* ExecutionRepo;
  const logger = yield* loggerFor(input.workflowId);

  yield* repo
    .recordAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: "run_cancel_requested",
      message: input.message,
      metadata: { eventName: input.eventName, outcome: "write_failed" },
    })
    .pipe(
      Effect.catchTag("DatabaseError", (failure) =>
        logger.error("Failed to record a refused ending", {
          run: { execution: input.executionId },
          error: failure.cause,
        })
      )
    );
});

/**
 * Cancels every in-flight execution named, each behind a compare-and-set on
 * its row that writes the run's `run_cancelled` entry with it.
 *
 * An execution that completed between the caller's candidate query and this
 * write loses nothing: the CAS fails, the row keeps its terminal status, no
 * entry is written, and the run is not counted as ended. An in-flight Cancel
 * or Exit claim remains owned by its run, which ends itself.
 *
 * Every failure is contained per execution, so one of them never discards the
 * summary for the executions that did end.
 */
export const cancelInFlightRuns = Effect.fn("cancelInFlightRuns")(function* (
  input: CancelInFlightRunsInput
) {
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
  const logger = yield* loggerFor(workflowId);

  const answer = yield* repo
    .cancelRun({
      executionId,
      reason: input.reason,
      eventName: input.eventName,
    })
    .pipe(
      Effect.catchTag("DatabaseError", (failure) =>
        Effect.gen(function* () {
          yield* logger.error("Failed to end an execution", {
            run: { execution: executionId },
            error: failure.cause,
          });
          yield* recordEndingFailure({
            workflowId,
            executionId,
            message: `${input.reason}: the status could not be written, so the run was not stopped`,
            eventName: input.eventName,
          });
          return null;
        })
      )
    );
  if (answer === null) return runEndOutcome("unreachable", executionId);

  switch (answer.kind) {
    case "ended":
      return runEndOutcome("ended", executionId);
    case "cancel_claimed":
    case "exit_claimed":
      yield* logger.info("Execution already has a termination claim", {
        run: { execution: executionId, claim: answer.kind },
      });
      return runEndOutcome("claim-pending", executionId);
    case "already_ended":
      yield* logger.info(
        "Execution reached a terminal status before it could be ended",
        { run: { execution: executionId } }
      );
      return runEndOutcome("lost-race", executionId);
    default:
      // `missing`: no row holds the id. A cancel ends every in-flight run
      // holding no claim, so `unclaimed` is never its answer.
      return runEndOutcome("unreachable", executionId);
  }
});
