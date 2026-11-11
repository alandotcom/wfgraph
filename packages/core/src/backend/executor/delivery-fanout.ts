/**
 * The fan-out of one inbox row's delivery: which workflows the Event
 * concerns, each one's Lifecycle Rules, and the parked Waits it wakes. Every
 * piece runs as a durable step on the pass's step memo, in the pass's fiber or
 * a child fiber the fan-out joins, so a step that committed is answered from
 * its memo row when the delivery runs again. A step id is the key of a stored
 * memo row, so renaming one makes a delivery in flight run that step a second
 * time.
 *
 * Each workflow is its own retry unit, and workflows are delivered side by
 * side. A step of one workflow that fails is memoized as that failure, so the
 * pass goes on to every other workflow, and the next pass tries that step
 * again under a new id. Once the delivery's retries are spent the workflow is
 * recorded as failed and the delivery settles with the others delivered.
 */

import { Cause, Data, Effect } from "effect";
import type {
  AnyEventDefinition,
  PayloadRejected,
} from "#src/backend/extensions/define-event";
import { failureFromCause } from "#src/backend/engine/engine-failure";
import { DEFAULT_QUERY_CONNECTIONS } from "#src/backend/lib/db/config";
import type { PassSteps } from "#src/backend/executor/runtime";
import {
  retriesSpent,
  STEP_RETRY_LIMIT,
} from "#src/backend/services/executions/repo/release-policy";
import {
  applyLifecycleRules,
  deliverWaitCandidates,
  type DeliveryFailureStage,
  listEventSubscribers,
  listWaitCandidatePage,
  recordDeliveryFailure,
  type LifecycleDeliveryOutcome,
  type WaitCandidatePage,
} from "#src/backend/services/workflows/lifecycle/deliver-event";
import type { EventSubscriber } from "#src/backend/services/workflows/repo";
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
  recordFailure: typeof recordDeliveryFailure;
};

export const deliverEventPorts: DeliveryFanOutPorts = {
  listSubscribers: listEventSubscribers,
  applyLifecycle: applyLifecycleRules,
  listWaitCandidates: listWaitCandidatePage,
  deliverWaitCandidates,
  recordFailure: recordDeliveryFailure,
};

/** One workflow the Event never fully reached, and the step that failed. */
export type DeliveryFailure = {
  workflowId: string;
  stage: DeliveryFailureStage;
  /** The first line of the last failure of the step. */
  error: string;
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
  /** The workflows whose delivery failed on every retry. */
  failures: DeliveryFailure[];
};

/**
 * The failure a pass's fan-out ends with while a workflow still has a step to
 * try again. The pass releases its row with a backoff, and the next pass
 * answers every other workflow from the memo.
 */
export class DeliveryStepsPending extends Data.TaggedError(
  "DeliveryStepsPending"
)<{ message: string }> {}

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

/** The first line of a failure message, so one inbox error stays readable. */
function firstLineOf(message: string): string {
  return message.split("\n")[0]?.trim() ?? message;
}

/**
 * A step's answer as the memo holds it: its value, or the failure it ended
 * with. Holding the failure as a value is what lets the pass go on.
 */
type TryAnswer<A> = { ok: true; value: A } | { ok: false; error: string };

/**
 * What a step of one workflow's delivery came to on this pass: its value, a
 * failure the next pass tries again, or a failure the delivery has no retry
 * left for.
 */
type Tried<A> =
  | { kind: "value"; value: A }
  | { kind: "pending"; error: string }
  | { kind: "spent"; error: string };

/** The id of a step's `tryIndex`th try. The first try keeps the plain id. */
function tryStepId(stepId: string, tryIndex: number): string {
  return tryIndex === 0 ? stepId : `${stepId}-retry-${tryIndex}`;
}

/**
 * Runs `step` as the durable step `stepId`, holding a failure as the step's
 * memoized value rather than stopping the pass.
 *
 * A try an earlier pass recorded as failed is followed by the next try, under
 * an id of its own, so each pass makes at most one new try of a step. A try
 * that fails on this pass is `pending` while the delivery has a retry left
 * and the step has not reached `STEP_RETRY_LIMIT` retries, and `spent`
 * otherwise. An interruption is left to stop the pass, since nothing failed.
 */
const tryStep = Effect.fnUntraced(function* <A, E, R>(input: {
  steps: PassSteps;
  stepId: string;
  step: Effect.Effect<A, E, R>;
  /** Whether a failure on this pass can still be tried again. */
  mayRetry: boolean;
}) {
  for (let tryIndex = 0; ; tryIndex += 1) {
    let ranThisPass = false;
    const answer: TryAnswer<A> = yield* input.steps.run(
      tryStepId(input.stepId, tryIndex),
      Effect.suspend(() => {
        ranThisPass = true;
        return input.step;
      }).pipe(
        Effect.map((value): TryAnswer<A> => ({ ok: true, value })),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.succeed<TryAnswer<A>>({
              ok: false,
              error: firstLineOf(failureFromCause(cause).message),
            })
        )
      )
    );
    if (answer.ok) {
      const tried: Tried<A> = { kind: "value", value: answer.value };
      return tried;
    }
    if (!ranThisPass) continue;
    const tried: Tried<A> =
      input.mayRetry && tryIndex < STEP_RETRY_LIMIT
        ? { kind: "pending", error: answer.error }
        : { kind: "spent", error: answer.error };
    return tried;
  }
});

/** What one workflow's delivery came to on this pass. */
type SubscriberDelivery =
  | {
      kind: "delivered";
      lifecycle: LifecycleDeliveryOutcome | undefined;
      resumedWaits: number;
      failure: DeliveryFailure | undefined;
    }
  | { kind: "pending"; workflowId: string; error: string };

/**
 * One delivered Event, fanned out, answering what it came to.
 *
 * Each workflow's Lifecycle Rules are a separate step from its waits, because a
 * wait delivery that fails must not replay a start. Wait candidates are saved in
 * bounded pages before any wake is written. Each page's delivery is a sibling
 * durable step, so a retry uses the original rows and does not discover a later
 * sequential Wait the same arrival caused.
 *
 * A workflow with a step still to retry keeps the fan-out from settling: once
 * every other workflow has been delivered this fails with
 * `DeliveryStepsPending`, which releases the row for a later pass.
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
    /**
     * The delivery row's own failure count, as the pass claimed it. A step
     * that fails while one more failure would spend the row's retries is
     * recorded as failed rather than tried again.
     */
    attempt: number;
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

    const mayRetry = !retriesSpent(input.attempt + 1);
    // Workflows are independent of one another, so they are delivered side by
    // side, as many at once as the pool has connections for. Precedence holds
    // within each workflow, whose rules and Waits stay in order.
    const deliveries: SubscriberDelivery[] = yield* Effect.forEach(
      subscribers,
      (subscriber) =>
        deliverToSubscriber({
          subscriber,
          event: deliveredEvent,
          payload,
          inboxId,
          mayRetry,
          steps,
          ports,
        }),
      { concurrency: DEFAULT_QUERY_CONNECTIONS }
    );

    const pending = deliveries.filter(
      (delivery) => delivery.kind === "pending"
    );
    if (pending.length > 0) {
      return yield* new DeliveryStepsPending({
        message: `A step failed for ${pending.length} of ${subscribers.length} workflow(s) and will be tried again: ${pending[0]?.error ?? ""}`,
      });
    }

    const summary: DeliverySummary = {
      workflows: subscribers.length,
      started: 0,
      canceled: 0,
      resumedWaits: 0,
      failures: [],
    };
    for (const delivery of deliveries) {
      if (delivery.kind !== "delivered") continue;
      const { lifecycle, failure } = delivery;
      if (lifecycle?.kind === "started") summary.started += 1;
      if (lifecycle?.kind === "canceled") {
        summary.canceled += lifecycle.canceledExecutionIds.length;
      }
      summary.resumedWaits += delivery.resumedWaits;
      if (failure !== undefined) summary.failures.push(failure);
    }

    // Each failed workflow's audit row is a step of its own, so a pass that
    // fails after writing one does not write it twice.
    for (const failure of summary.failures) {
      const subscriber = subscribers.find(
        (candidate) => candidate.id === failure.workflowId
      );
      if (subscriber === undefined) continue;
      yield* steps.run(
        `failure-${subscriber.id}`,
        Effect.suspend(() =>
          ports.recordFailure({
            subscriber,
            eventName: event.name,
            deliveryId: inboxId,
            stage: failure.stage,
          })
        )
      );
    }

    return summary;
  }
);

/**
 * The Event, delivered to one workflow: its Lifecycle Rules, then its parked
 * Waits. A lifecycle step still to retry leaves the Waits for a later pass,
 * because Precedence applies the rules first. A lifecycle step whose retries
 * are spent still lets the Event reach the Waits, which no rule settled.
 */
const deliverToSubscriber = Effect.fnUntraced(function* (input: {
  subscriber: EventSubscriber;
  event: Parameters<DeliveryFanOutPorts["applyLifecycle"]>[0]["event"];
  payload: JsonObject;
  inboxId: string;
  mayRetry: boolean;
  steps: PassSteps;
  ports: DeliveryFanOutPorts;
}) {
  const { subscriber, steps, ports } = input;
  const workflowId = subscriber.id;

  // The role says this workflow named the Event as a start or a cancel
  // somewhere in the graph it holds now; the rules read inside the step
  // decide whether it still does. Both checks are wanted: this one keeps a
  // wait-only delivery off the graph column, and that one is what either
  // role is actually held to.
  const holdsLifecycleRole = subscriber.roles.some(
    (role) => role === "start" || role === "cancel"
  );
  const tried: Tried<LifecycleDeliveryOutcome> = holdsLifecycleRole
    ? yield* tryStep({
        steps,
        stepId: `lifecycle-${workflowId}`,
        step: Effect.suspend(() =>
          ports.applyLifecycle({
            subscriber,
            event: input.event,
            payload: input.payload,
            deliveryId: input.inboxId,
          })
        ),
        mayRetry: input.mayRetry,
      })
    : { kind: "value", value: { kind: "waits_only", workflowId } };

  if (tried.kind === "pending") {
    const pending: SubscriberDelivery = {
      kind: "pending",
      workflowId,
      error: tried.error,
    };
    return pending;
  }
  const lifecycle = tried.kind === "value" ? tried.value : undefined;
  const lifecycleFailure: DeliveryFailure | undefined =
    tried.kind === "spent"
      ? { workflowId, stage: "lifecycle", error: tried.error }
      : undefined;

  // A workflow that is gone has no Waits left to offer the Event.
  const waits =
    lifecycle?.kind === "skipped" && lifecycle.reason === "workflow_gone"
      ? ({ kind: "delivered", resumedWaits: 0 } as const)
      : yield* deliverToWaits({
          subscriber,
          event: input.event,
          payload: input.payload,
          inboxId: input.inboxId,
          // A run this delivery just settled takes no wait: a superseded or
          // claimed run is ending, and the run just started has parked
          // nothing yet.
          excluding:
            lifecycle === undefined ? [] : settledExecutionIds(lifecycle),
          mayRetry: input.mayRetry,
          steps,
          ports,
        });

  if (waits.kind === "pending") {
    const pending: SubscriberDelivery = {
      kind: "pending",
      workflowId,
      error: waits.error,
    };
    return pending;
  }

  yield* Effect.logDebug("Delivered an event to a workflow").pipe(
    Effect.annotateLogs({
      workflow: { id: workflowId, roles: subscriber.roles },
      // A refusal and a skip each name themselves, so a builder's mistake
      // can be told from a payload's gap.
      outcome: {
        kind: lifecycle?.kind ?? "failed",
        reason:
          lifecycle !== undefined && "reason" in lifecycle
            ? lifecycle.reason
            : undefined,
      },
      waits: { resumed: waits.resumedWaits },
    })
  );

  const delivered: SubscriberDelivery = {
    kind: "delivered",
    lifecycle,
    resumedWaits: waits.resumedWaits,
    failure:
      lifecycleFailure ??
      (waits.kind === "spent"
        ? { workflowId, stage: "waits", error: waits.error }
        : undefined),
  };
  return delivered;
});

/** What offering the Event to one workflow's parked Waits came to. */
type WaitsDelivery =
  | { kind: "delivered"; resumedWaits: number }
  | { kind: "pending"; error: string }
  | { kind: "spent"; resumedWaits: number; error: string };

/**
 * Offers the Event to one workflow's parked Waits, answering how many it
 * woke. Every candidate page is saved before any wake is written, so a
 * candidate page still to retry writes no wake on this pass.
 */
const deliverToWaits = Effect.fnUntraced(function* (input: {
  subscriber: { id: string; roles: readonly string[] };
  event: Parameters<DeliveryFanOutPorts["deliverWaitCandidates"]>[0]["event"];
  payload: JsonObject;
  inboxId: string;
  excluding: string[];
  mayRetry: boolean;
  steps: PassSteps;
  ports: DeliveryFanOutPorts;
}) {
  const { subscriber, steps, ports } = input;
  // The wait role is pushed from the parked-run read. A subscriber without it
  // cannot gain a wait role on retry because that list is memoized. For a
  // subscriber that does have it, the candidate pages below become the fixed
  // set this arrival can wake.
  if (!subscriber.roles.includes("wait")) {
    const none: WaitsDelivery = { kind: "delivered", resumedWaits: 0 };
    return none;
  }

  const candidatePages: WaitCandidatePage[] = [];
  let afterId: string | undefined;
  for (let pageIndex = 0; ; pageIndex += 1) {
    const pageAfterId = afterId;
    const tried = yield* tryStep({
      steps,
      stepId: `wait-candidates-${subscriber.id}-${pageIndex}`,
      step: Effect.suspend(() =>
        ports.listWaitCandidates({
          workflowId: subscriber.id,
          eventName: input.event.name,
          afterId: pageAfterId,
          excludingExecutionIds: input.excluding,
        })
      ),
      mayRetry: input.mayRetry,
    });
    if (tried.kind === "pending") {
      const pending: WaitsDelivery = { kind: "pending", error: tried.error };
      return pending;
    }
    if (tried.kind === "spent") {
      const spent: WaitsDelivery = {
        kind: "spent",
        resumedWaits: 0,
        error: tried.error,
      };
      return spent;
    }
    const page = tried.value;
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
  let pendingError: string | undefined;
  let spentError: string | undefined;
  for (const [pageIndex, page] of candidatePages.entries()) {
    const tried = yield* tryStep({
      steps,
      stepId: `waits-${subscriber.id}-${pageIndex}`,
      step: Effect.suspend(() =>
        ports.deliverWaitCandidates({
          workflowId: subscriber.id,
          event: input.event,
          payload: input.payload,
          candidates: page.candidates,
          deliveryId: input.inboxId,
        })
      ),
      mayRetry: input.mayRetry,
    });
    if (tried.kind === "value") resumedWaits += tried.value.resumedWaits;
    if (tried.kind === "pending") pendingError ??= tried.error;
    if (tried.kind === "spent") spentError ??= tried.error;
  }

  const delivered: WaitsDelivery =
    pendingError !== undefined
      ? { kind: "pending", error: pendingError }
      : spentError !== undefined
        ? { kind: "spent", resumedWaits, error: spentError }
        : { kind: "delivered", resumedWaits };
  return delivered;
});
