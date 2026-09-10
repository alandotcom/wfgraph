/**
 * Waking the runs an arriving Event was the thing they parked for.
 *
 * Claim and delivery are one unit: a run is counted once its durable signal is
 * accepted and its exact claim is settled. The claim stops two deliveries from
 * waking one node, while the resumed engine records the consumed wake.
 */

import { Effect } from "effect";
import { evaluateCompiledCondition } from "#src/backend/lib/cel/condition-payload";
import { DEFAULT_QUERY_CONNECTIONS } from "#src/backend/lib/db/config";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { readCompiledWaitSubscriptions } from "#src/backend/engine/wait-match";
import { wakeWait } from "#src/backend/services/workflows/lifecycle/wake-wait";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { connectionMatches } from "@wfgraph/shared/lifecycle/event-connections";

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
  connectionId?: string | undefined;
}): WaitMatchResult {
  const subscriptions = readCompiledWaitSubscriptions(
    input.waitState.metadata
  ).filter(
    (subscription) =>
      subscription.event === input.eventType &&
      connectionMatches(subscription.connectionId, input.connectionId)
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
    eventType?: string | undefined;
    payload: JsonObject;
    waitStates: CandidateWaitState[];
    connectionId?: string | undefined;
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
  connectionId?: string | undefined;
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

  return yield* Effect.map(
    wakeWait({
      target: {
        kind: "wait_state",
        waitStateId: waitState.id,
        token: resumeToken,
        eventName: eventType,
      },
      payload: input.payload,
    }),
    // A raced settle counts as none here: the run did wake, but another writer
    // owns that claim and is the one counting it.
    (outcome) => (outcome.status === "resumed" ? 1 : 0)
  ).pipe(
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
