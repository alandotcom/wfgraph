/**
 * A Cancel Event, routed to the runs it concerns.
 *
 * ADR-0007 rules out killing an Inngest run, so a cancellation is a routed
 * continuation: the authority is a flag on the execution row, and the run reads
 * it at its next node boundary and enters its Canceled outlet with every landed
 * node output intact. Two facts shape the rest. A running Execution cannot
 * receive a signal from inside `step.run`, and a parked one is reaching no step
 * boundary at all -- so the flag is written for every run and a nudge is sent to
 * the ones standing on a wait.
 */

import { Effect } from "effect";
import { DEFAULT_QUERY_CONNECTIONS } from "#src/backend/lib/db/config";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import {
  ExecutionRepo,
  type WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import type { JsonObject } from "@rova/shared/types/json";
import type { WorkflowMode } from "@rova/shared/graph/types";

/**
 * Claims every in-flight run of this workflow about this entity for the Canceled
 * outlet, answering the ids claimed.
 *
 * The ids come back so the delivery can keep the same Event off those runs'
 * waits: they are ending, and waking one would resume a run on its way out.
 * A nudge that fails to send does not take an id off the list, because the flag
 * is already written and is the one authority; the run reaches its outlet on its
 * next boundary either way, and a parked one at its wait timeout.
 */
export const requestCanceledOutlet = Effect.fn("requestCanceledOutlet")(
  function* (input: {
    workflowId: string;
    runMode: WorkflowMode;
    eventName: string;
    payload: JsonObject;
    entityValue: string;
  }) {
    const repo = yield* ExecutionRepo;
    const logger = (yield* AppLogger).get("workflow", "lifecycle-cancel");

    const claimed = yield* repo.requestCancelForEntity({
      workflowId: input.workflowId,
      entityValue: input.entityValue,
      runMode: input.runMode,
      eventName: input.eventName,
      payload: input.payload,
    });

    if (claimed.length === 0) {
      return claimed;
    }

    // One read for the whole claimed set. The claim itself is one statement, so
    // asking each run separately would be that set taken apart again, and an
    // entity with many in-flight runs would queue those reads against a pool of
    // ten.
    //
    // A refused read is contained rather than raised, for the same reason a
    // refused send is: the flag is written and the claim cannot be re-made, so
    // failing here would leave the claimed runs asleep until their wait timeout
    // with no retry able to reach them.
    const parkedByExecution = yield* repo
      .listWaitingStatesForExecutions(claimed)
      .pipe(
        Effect.catch((error) =>
          logger
            .error("Failed to read the waits of claimed runs", {
              workflowId: input.workflowId,
              eventName: input.eventName,
              error,
            })
            .pipe(Effect.as(new Map<string, WorkflowWaitState[]>()))
        )
      );

    yield* Effect.forEach(
      claimed,
      (executionId) =>
        nudgeParkedWaits({
          workflowId: input.workflowId,
          executionId,
          eventName: input.eventName,
          payload: input.payload,
          parked: parkedByExecution.get(executionId) ?? [],
        }),
      { concurrency: DEFAULT_QUERY_CONNECTIONS }
    );

    return claimed;
  }
);

/**
 * Wakes whichever nodes of one claimed run are parked, and records the claim on
 * its timeline.
 *
 * Every failure is contained here: a refused query or a send Inngest would not
 * take must not stop the other claimed runs from being woken.
 */
const nudgeParkedWaits = Effect.fn("nudgeParkedWaits")(function* (input: {
  workflowId: string;
  executionId: string;
  eventName: string;
  payload: JsonObject;
  /** This run's parked waits, from the caller's one read over the claimed set. */
  parked: WorkflowWaitState[];
}) {
  const repo = yield* ExecutionRepo;
  const inngest = yield* InngestClient;
  const logger = (yield* AppLogger).get("workflow", "lifecycle-cancel");

  yield* Effect.gen(function* () {
    yield* Effect.forEach(
      input.parked,
      (waitState) =>
        inngest.sendWaitSignal({
          executionId: input.executionId,
          nodeId: waitState.nodeId,
          token: waitState.resumeToken,
          eventType: input.eventName,
          payload: input.payload,
          signalType: "lifecycle-cancel",
        }),
      { concurrency: DEFAULT_QUERY_CONNECTIONS }
    );

    yield* repo.recordAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: "run_cancel_requested",
      message: `Cancellation requested by ${input.eventName}`,
      metadata: {
        eventName: input.eventName,
        parkedWaits: input.parked.length,
      },
    });
  }).pipe(
    Effect.catch((error) =>
      logger.error("Failed to nudge a run claimed for cancellation", {
        workflowId: input.workflowId,
        executionId: input.executionId,
        eventName: input.eventName,
        error,
      })
    )
  );
});
