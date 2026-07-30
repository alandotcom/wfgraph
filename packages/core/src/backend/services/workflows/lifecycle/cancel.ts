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
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { getAppLogger } from "#src/backend/lib/logger";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo/index";
import type { JsonObject } from "@rova/shared/types/json";
import type { WorkflowMode } from "@rova/shared/workflow/types";

const logger = getAppLogger("workflow", "lifecycle-cancel");

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

    yield* Effect.forEach(
      claimed,
      (executionId) =>
        nudgeParkedWaits({
          workflowId: input.workflowId,
          executionId,
          eventName: input.eventName,
          payload: input.payload,
        }),
      { concurrency: "unbounded" }
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
}) {
  const repo = yield* ExecutionRepo;
  const inngest = yield* InngestClient;

  yield* Effect.gen(function* () {
    const waiting = yield* repo.listWaitingStates(input.executionId);

    yield* Effect.forEach(
      waiting,
      (waitState) =>
        inngest.sendWaitSignal({
          executionId: input.executionId,
          nodeId: waitState.nodeId,
          token: waitState.resumeToken,
          eventType: input.eventName,
          payload: input.payload,
          signalType: "lifecycle-cancel",
        }),
      { concurrency: "unbounded" }
    );

    yield* repo.recordAuditEvent({
      workflowId: input.workflowId,
      executionId: input.executionId,
      eventType: "run_cancel_requested",
      message: `Cancellation requested by ${input.eventName}`,
      metadata: { eventName: input.eventName, parkedWaits: waiting.length },
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.error("Failed to nudge a run claimed for cancellation", {
          workflowId: input.workflowId,
          executionId: input.executionId,
          eventName: input.eventName,
          error,
        });
      })
    )
  );
});
