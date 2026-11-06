/**
 * The fan-out of one inbox row's delivery: which workflows the Event
 * concerns, each one's Lifecycle Rules, and the parked Waits it wakes. Every
 * piece runs as a durable step on the pass's step memo, in the pass's own
 * fiber, so a step that committed is answered from its memo row when the
 * delivery runs again. A step id is the key of a stored memo row, so renaming
 * one makes a delivery in flight run that step a second time.
 */

import { Effect } from "effect";
import type {
  AnyEventDefinition,
  PayloadRejected,
} from "#src/backend/extensions/define-event";
import type { PassSteps } from "#src/backend/executor/runtime";
import {
  applyLifecycleRules,
  deliverWaitCandidates,
  listEventSubscribers,
  listWaitCandidatePage,
  type LifecycleDeliveryOutcome,
  type WaitCandidatePage,
} from "#src/backend/services/workflows/lifecycle/deliver-event";
import type { JsonObject } from "@wfgraph/shared/types/json";

/**
 * An inbox row's data, gated through the Event it resolved to. `payload` is
 * the data as it arrived, which a started run takes as its input and a Wait
 * matches against; `validated` is what the Event's schema decoded it to,
 * which the Event's Entity bindings select from.
 */
export type DecodedArrival = {
  event: AnyEventDefinition;
  payload: JsonObject;
  validated: unknown;
};

/** Gates `payload` through `event`'s schema, failing with the refusal. */
export function decodeArrival(
  event: AnyEventDefinition,
  payload: JsonObject
): Effect.Effect<DecodedArrival, PayloadRejected> {
  return event
    .decodePayloadValue(payload)
    .pipe(Effect.map((validated) => ({ event, payload, validated })));
}

/**
 * The deliver halves the fan-out runs in its steps. `deliverEventPorts` is
 * the one set the delivery body passes; a test passes stand-ins. Each is
 * called only when its step runs, never for a step the memo answers.
 */
export type DeliveryFanOutPorts = {
  listSubscribers: typeof listEventSubscribers;
  applyLifecycle: typeof applyLifecycleRules;
  listWaitCandidates: typeof listWaitCandidatePage;
  deliverWaitCandidates: typeof deliverWaitCandidates;
};

export const deliverEventPorts: DeliveryFanOutPorts = {
  listSubscribers: listEventSubscribers,
  applyLifecycle: applyLifecycleRules,
  listWaitCandidates: listWaitCandidatePage,
  deliverWaitCandidates,
};

/** What one delivery came to, across every workflow it reached. */
export type DeliverySummary = {
  /** The workflows the Event concerned. */
  workflows: number;
  /** The runs the Lifecycle Rules started. */
  started: number;
  /** The runs a Cancel Event claimed for their Canceled outlet. */
  canceled: number;
  /** The parked Waits the Event woke. */
  resumedWaits: number;
};

/** The runs the Lifecycle Rules settled, which the wait half then leaves alone. */
function settledExecutionIds(outcome: LifecycleDeliveryOutcome): string[] {
  if (outcome.kind === "started") {
    return [outcome.executionId, ...outcome.supersededExecutionIds];
  }
  if (outcome.kind === "canceled") {
    return outcome.canceledExecutionIds;
  }
  return [];
}

/**
 * One delivered Event, fanned out, answering what it came to.
 *
 * Each workflow's Lifecycle Rules are a separate step from its waits, because a
 * wait delivery that fails must not replay a start. Wait candidates are saved in
 * bounded pages before any wake is written. Each page's delivery is a sibling
 * durable step, so a retry uses the original rows and does not discover a later
 * sequential Wait the same arrival caused.
 */
export const fanOutDelivery = Effect.fn("wfgraph.delivery.fan_out")(
  function* (input: {
    arrival: DecodedArrival;
    /**
     * The inbox row being delivered. Its id is the delivery id both halves
     * write: the lifecycle's committed decision and every wake.
     */
    inboxId: string;
    /** The Connection this arrival came through, or null for a host Event. */
    connectionId: string | null;
    steps: PassSteps;
    ports: DeliveryFanOutPorts;
  }) {
    const { arrival, steps, ports, inboxId } = input;
    const { event, payload } = arrival;

    const deliveredEvent = {
      name: event.name,
      correlationPath: event.correlationPath,
      connectionId: input.connectionId ?? undefined,
      entityBindings: event.entities,
      validatedPayload: arrival.validated,
    };

    const subscribers = yield* steps.run(
      `subscribers-${event.name}`,
      Effect.suspend(() => ports.listSubscribers(event.name))
    );

    const summary: DeliverySummary = {
      workflows: subscribers.length,
      started: 0,
      canceled: 0,
      resumedWaits: 0,
    };

    for (const subscriber of subscribers) {
      // The role says this workflow named the Event as a start or a cancel
      // somewhere in the graph it holds now; the rules read inside the step
      // decide whether it still does. Both checks are wanted: this one keeps
      // a wait-only delivery off the graph column, and that one is what
      // either role is actually held to.
      const lifecycle: LifecycleDeliveryOutcome = subscriber.roles.some(
        (role) => role === "start" || role === "cancel"
      )
        ? yield* steps.run(
            `lifecycle-${subscriber.id}`,
            Effect.suspend(() =>
              ports.applyLifecycle({
                subscriber,
                event: deliveredEvent,
                payload,
                deliveryId: inboxId,
              })
            )
          )
        : { kind: "waits_only", workflowId: subscriber.id };

      if (lifecycle.kind === "started") summary.started += 1;
      if (lifecycle.kind === "canceled") {
        summary.canceled += lifecycle.canceledExecutionIds.length;
      }

      let resumedWaits = 0;
      // A workflow that is gone has no Waits left to offer the Event.
      if (
        !(lifecycle.kind === "skipped" && lifecycle.reason === "workflow_gone")
      ) {
        resumedWaits = yield* deliverToWaits({
          subscriber,
          event: deliveredEvent,
          payload,
          inboxId,
          // A run this delivery just settled takes no wait: a superseded or
          // claimed run is ending, and the run just started has parked
          // nothing yet.
          excluding: settledExecutionIds(lifecycle),
          steps,
          ports,
        });
      }
      summary.resumedWaits += resumedWaits;

      yield* Effect.logDebug("Delivered an event to a workflow").pipe(
        Effect.annotateLogs({
          workflow: { id: subscriber.id, roles: subscriber.roles },
          // A refusal and a skip each name themselves, so a builder's mistake
          // can be told from a payload's gap.
          outcome: {
            kind: lifecycle.kind,
            reason: "reason" in lifecycle ? lifecycle.reason : undefined,
          },
          waits: { resumed: resumedWaits },
        })
      );
    }

    return summary;
  }
);

/**
 * Offers the Event to one workflow's parked Waits, answering how many it
 * woke. Every candidate page is saved before any wake is written.
 */
const deliverToWaits = Effect.fnUntraced(function* (input: {
  subscriber: { id: string; roles: readonly string[] };
  event: Parameters<DeliveryFanOutPorts["deliverWaitCandidates"]>[0]["event"];
  payload: JsonObject;
  inboxId: string;
  excluding: string[];
  steps: PassSteps;
  ports: DeliveryFanOutPorts;
}) {
  const { subscriber, steps, ports } = input;
  // The wait role is pushed from the parked-run read. A subscriber without it
  // cannot gain a wait role on retry because that list is memoized. For a
  // subscriber that does have it, the candidate pages below become the fixed
  // set this arrival can wake.
  if (!subscriber.roles.includes("wait")) return 0;

  const candidatePages: WaitCandidatePage[] = [];
  let afterId: string | undefined;
  for (let pageIndex = 0; ; pageIndex += 1) {
    const page = yield* steps.run(
      `wait-candidates-${subscriber.id}-${pageIndex}`,
      Effect.suspend(() =>
        ports.listWaitCandidates({
          workflowId: subscriber.id,
          eventName: input.event.name,
          afterId,
          excludingExecutionIds: input.excluding,
        })
      )
    );
    candidatePages.push(page);
    if (!page.hasMore) break;
    if (!page.afterId) {
      return yield* Effect.die(
        new Error("A full wait candidate page has no cursor")
      );
    }
    afterId = page.afterId;
  }

  let resumedWaits = 0;
  for (const [pageIndex, page] of candidatePages.entries()) {
    const delivered = yield* steps.run(
      `waits-${subscriber.id}-${pageIndex}`,
      Effect.suspend(() =>
        ports.deliverWaitCandidates({
          workflowId: subscriber.id,
          event: input.event,
          payload: input.payload,
          candidates: page.candidates,
          deliveryId: input.inboxId,
        })
      )
    );
    resumedWaits += delivered.resumedWaits;
  }
  return resumedWaits;
});
