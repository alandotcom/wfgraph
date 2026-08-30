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
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { readCompiledWaitSubscriptions } from "#src/backend/engine/wait-match";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
import type { JsonObject } from "@wfgraph/shared/types/json";

type CandidateWaitState = {
  id: string;
  executionId: string;
  nodeId: string;
  resumeToken: string | null;
  subscribedEvents: string[] | null;
  metadata: Record<string, unknown> | null;
};

/** Whether the row matched, and the error from every subscription that could not be evaluated. */
type WaitMatchResult = { matched: boolean; unevaluated: string[] };

/**
 * Whether this arrival is one this row parked for.
 *
 * The row's own subscriptions decide, not the node's current ones: the node may
 * name different Events by now, and the run is owed what it waited for. A
 * subscription with no expression resumes on the next occurrence of its Event,
 * which is what the editor says a match-free subscription means.
 *
 * An expression that fails to evaluate does not wake the run: the payload
 * arrived from outside and may carry anything, so a field of the wrong type is
 * a payload that does not satisfy the match rather than a reason to resume. Its
 * error is handed back rather than logged here, because a pure predicate has no
 * logger of its own; `resumeOneWait` narrates it.
 */
function waitStateMatches(input: {
  waitState: CandidateWaitState;
  eventType: string;
  payload: JsonObject;
  connectionId?: string;
}): WaitMatchResult {
  const subscriptions = readCompiledWaitSubscriptions(
    input.waitState.metadata
  ).filter(
    (subscription) =>
      subscription.event === input.eventType &&
      (subscription.connectionId === undefined ||
        subscription.connectionId === input.connectionId)
  );

  const unevaluated: string[] = [];

  for (const subscription of subscriptions) {
    if (!subscription.match) {
      return { matched: true, unevaluated };
    }

    const evaluation = evaluateCompiledCondition({
      ...subscription.match,
      payload: input.payload,
      eventName: input.eventType,
      connectionId: input.connectionId ?? null,
    });

    if (!evaluation.ok) {
      unevaluated.push(evaluation.error);
      continue;
    }

    if (evaluation.value) {
      return { matched: true, unevaluated };
    }
  }

  return { matched: false, unevaluated };
}

/** How many runs this arrival woke. */
export const resumeWaitsMatchingEvent = Effect.fn("resumeWaitsMatchingEvent")(
  function* (input: {
    workflowId: string;
    eventType?: string;
    payload: JsonObject;
    waitStates: CandidateWaitState[];
    connectionId?: string;
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
          connectionId: input.connectionId,
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
  connectionId?: string;
}) {
  const { waitState, eventType } = input;
  const logger = (yield* AppLogger).get("wait-resume");
  const resumeToken = waitState.resumeToken;
  if (!resumeToken) {
    // A row with no token can never be woken by an Event, whatever arrives, so
    // this is a defect in whatever wrote it rather than a routine miss.
    yield* logger.warn("Parked wait carries no resume token", {
      workflowId: input.workflowId,
      eventType,
      waitStateId: waitState.id,
      executionId: waitState.executionId,
      nodeId: waitState.nodeId,
    });
    return 0;
  }

  const { matched, unevaluated } = waitStateMatches({
    waitState,
    eventType,
    payload: input.payload,
    connectionId: input.connectionId,
  });

  for (const error of unevaluated) {
    yield* logger.warn("Wait match did not evaluate", {
      workflowId: input.workflowId,
      eventType,
      waitStateId: waitState.id,
      executionId: waitState.executionId,
      nodeId: waitState.nodeId,
      error,
    });
  }

  if (!matched) {
    // "The Event arrived and my run is still parked" is the question this module
    // exists to answer, and the row's frozen predicate is the only copy of the
    // rule: nothing can re-derive it from the graph the builder is looking at.
    yield* logger.debug("Wait match rejected an arrival", {
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
    const claim = yield* repo.claimWaitingStateById(waitState.id);
    if (!claim) {
      return 0;
    }
    const { waitState: claimedWait, claimedAt } = claim;

    yield* inngest
      .sendWaitSignal({
        executionId: claimedWait.executionId,
        nodeId: claimedWait.nodeId,
        token: resumeToken,
        eventType,
        payload: input.payload,
        signalType: "wait-resume",
      })
      .pipe(
        Effect.tapError(() =>
          repo
            .releaseWaitingStateClaim({
              waitStateId: claimedWait.id,
              claimedAt,
            })
            .pipe(
              Effect.catchTag("DatabaseError", (releaseFailure) =>
                logger.error("Failed to release refused wait-resume claim", {
                  workflowId: input.workflowId,
                  eventType,
                  waitStateId: claimedWait.id,
                  error: releaseFailure.cause,
                })
              )
            )
        )
      );

    const waitStateUpdated = yield* repo.settleWaitingStateClaim({
      waitStateId: claimedWait.id,
      claimedAt,
    });

    if (!waitStateUpdated) {
      return 0;
    }

    yield* Effect.all(
      [
        repo.markRunning(claimedWait.executionId),
        repo.recordAuditEvent({
          workflowId: input.workflowId,
          executionId: claimedWait.executionId,
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
      logger
        .error("Failed to resume wait", {
          workflowId: input.workflowId,
          eventType,
          waitStateId: waitState.id,
          executionId: waitState.executionId,
          nodeId: waitState.nodeId,
          error,
        })
        .pipe(Effect.as(0))
    )
  );
});
