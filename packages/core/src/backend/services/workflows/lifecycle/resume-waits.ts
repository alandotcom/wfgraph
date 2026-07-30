/**
 * Waking the runs an arriving Event was the thing they parked for.
 *
 * The signal and the bookkeeping around it are one unit: a run is only counted
 * as resumed once its wait row has moved out of `waiting`, which is what stops
 * two deliveries of the same Event waking one node twice.
 */

import { Effect } from "effect";
import { evaluateCompiledCondition } from "#src/backend/lib/cel/condition-payload";
import { DEFAULT_QUERY_CONNECTIONS } from "#src/backend/lib/db/config";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { getAppLogger } from "#src/backend/lib/logger";
import { readCompiledWaitSubscriptions } from "#src/backend/lib/workflow-engine/wait-match";
import { ExecutionRepo } from "#src/backend/services/workflows/executions/repo/index";
import type { JsonObject } from "@rova/shared/types/json";

const logger = getAppLogger("workflow", "wait-resume");

type CandidateWaitState = {
  id: string;
  executionId: string;
  nodeId: string;
  resumeToken: string | null;
  subscribedEvents: string[] | null;
  metadata: Record<string, unknown> | null;
};

/**
 * Whether this arrival is one this row parked for.
 *
 * The row's own subscriptions decide, not the node's current ones: the node may
 * name different Events by now, and the run is owed what it waited for. A
 * subscription with no expression resumes on the next occurrence of its Event,
 * which is what the editor says a match-free subscription means.
 *
 * An expression that fails to evaluate does not wake the run. The payload
 * arrived from outside and may carry anything, so a field of the wrong type is a
 * payload that does not satisfy the match rather than a reason to resume.
 */
function waitStateMatches(input: {
  waitState: CandidateWaitState;
  eventType: string;
  payload: JsonObject;
}): boolean {
  const subscriptions = readCompiledWaitSubscriptions(
    input.waitState.metadata
  ).filter((subscription) => subscription.event === input.eventType);

  return subscriptions.some((subscription) => {
    if (!subscription.match) {
      return true;
    }

    const evaluation = evaluateCompiledCondition({
      ...subscription.match,
      payload: input.payload,
    });

    if (!evaluation.ok) {
      logger.warn("Wait match did not evaluate", {
        eventType: input.eventType,
        waitStateId: input.waitState.id,
        error: evaluation.error,
      });
      return false;
    }

    return evaluation.value;
  });
}

/** How many runs this arrival woke. */
export const resumeWaitsMatchingEvent = Effect.fn("resumeWaitsMatchingEvent")(
  function* (input: {
    workflowId: string;
    eventType?: string;
    payload: JsonObject;
    waitStates: CandidateWaitState[];
  }) {
    const { eventType } = input;
    if (!eventType) {
      return 0;
    }

    // Bounded because each woken run costs a send and three writes, and the
    // parked population this walks is not bounded by anything: an event wait
    // defaults to a 7-day timeout, so one arrival can find a week's runs.
    const resumed = yield* Effect.forEach(
      input.waitStates,
      (waitState) =>
        resumeOneWait({
          workflowId: input.workflowId,
          eventType,
          payload: input.payload,
          waitState,
        }),
      { concurrency: DEFAULT_QUERY_CONNECTIONS }
    );

    return resumed.reduce<number>((total, count) => total + count, 0);
  }
);

/**
 * One wait, woken or left alone, answering 1 or 0 so the caller can add them up.
 *
 * Every failure is contained here: a send Inngest refused, a row another
 * delivery already moved, or an audit write that would not land must not stop
 * the other runs parked on the same Event from waking.
 */
const resumeOneWait = Effect.fn("resumeOneWait")(function* (input: {
  workflowId: string;
  eventType: string;
  payload: JsonObject;
  waitState: CandidateWaitState;
}) {
  const { waitState, eventType } = input;
  const resumeToken = waitState.resumeToken;
  if (!resumeToken) {
    // A row with no token can never be woken by an Event, whatever arrives, so
    // this is a defect in whatever wrote it rather than a routine miss.
    logger.warn("Parked wait carries no resume token", {
      workflowId: input.workflowId,
      eventType,
      waitStateId: waitState.id,
      executionId: waitState.executionId,
      nodeId: waitState.nodeId,
    });
    return 0;
  }

  if (!waitStateMatches({ waitState, eventType, payload: input.payload })) {
    // "The Event arrived and my run is still parked" is the question this module
    // exists to answer, and the row's frozen predicate is the only copy of the
    // rule: nothing can re-derive it from the graph the builder is looking at.
    logger.debug("Wait match rejected an arrival", {
      workflowId: input.workflowId,
      eventType,
      waitStateId: waitState.id,
      executionId: waitState.executionId,
      nodeId: waitState.nodeId,
      subscribedEvents: waitState.subscribedEvents,
    });
    return 0;
  }

  const repo = yield* ExecutionRepo;
  const inngest = yield* InngestClient;

  return yield* Effect.gen(function* () {
    yield* inngest.sendWaitSignal({
      executionId: waitState.executionId,
      nodeId: waitState.nodeId,
      token: resumeToken,
      eventType,
      payload: input.payload,
      signalType: "wait-resume",
    });

    const waitStateUpdated = yield* repo.markWaitStatus({
      waitStateId: waitState.id,
      status: "resumed",
    });

    if (!waitStateUpdated) {
      return 0;
    }

    yield* Effect.all(
      [
        repo.markRunning(waitState.executionId),
        repo.recordAuditEvent({
          workflowId: input.workflowId,
          executionId: waitState.executionId,
          eventType: "run_resumed",
          message: `Run resumed from wait on ${eventType}`,
          metadata: { eventType },
        }),
      ],
      { concurrency: "unbounded" }
    );

    return 1;
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.error("Failed to resume wait", {
          workflowId: input.workflowId,
          eventType,
          waitStateId: waitState.id,
          executionId: waitState.executionId,
          nodeId: waitState.nodeId,
          error,
        });
        return 0;
      })
    )
  );
});
