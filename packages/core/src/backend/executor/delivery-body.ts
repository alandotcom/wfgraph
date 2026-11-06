/**
 * The pass body of a `delivery` schedule row: load the arrival's inbox row,
 * tell which catalog Event it is, gate its data through that Event's schema,
 * and fan it out with `runEventListener`, whose steps run on the pass's step
 * memo. A delivery that ran to its end marks the inbox row `delivered`. One
 * whose row names no Event, whose data the Event refuses, or whose step spent
 * its retries marks the row `failed` with the reason, so the poll never
 * schedules it again. Each settling write deletes the schedule row.
 */

import { Effect } from "effect";
import { failureFromUnknown } from "#src/backend/engine/engine-failure";
import type { AnyEventDefinition } from "#src/backend/extensions/define-event";
import type {
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import {
  defaultDeliverPorts,
  type EventListenerDeliverPorts,
  runEventListener,
} from "#src/backend/lib/inngest/event-listener-function";
import type { WfGraphRuntime } from "#src/backend/runtime";
import type {
  DeliveryPass,
  OpenedBody,
  PassBody,
} from "#src/backend/executor/pass";
import {
  ExecutionRepo,
  type InboxEvent,
} from "#src/backend/services/executions/repo";
import { matchesSourceFilter } from "@wfgraph/shared/lifecycle/event-source-filter";

/** What a delivery body needs beyond the repository it runs on. */
export type DeliverySettings = {
  /** The catalog Events an inbox row can be. */
  events: readonly AnyEventDefinition[];
  /** The app's Layer graph, which runs the services a delivery's steps call. */
  runtime: WfGraphRuntime;
};

/**
 * Which catalog Event an inbox row is.
 *
 * - `event`: the row is `event`.
 * - `unmatched_source`: the row names a source, and no Event on it accepts the
 *   row's data. Inngest skips such an arrival, so nothing is owed it.
 * - `unknown`: the row names neither an Event nor a source.
 */
type InboxEventMatch =
  | { kind: "event"; event: AnyEventDefinition }
  | { kind: "unmatched_source" }
  | { kind: "unknown" };

/**
 * Answers which catalog Event an inbox row is. A send names the Event it
 * raises, so a row named after an Event is that Event. Webhook intake names
 * the source the vendor's message arrived on, and the row is the Event on that
 * source whose `source.when` its data satisfies. `event-uniqueness.ts` keeps
 * at most one Event on a source accepting any payload. Both lookups are keyed
 * by a `Map`, since the row's name is whatever its sender wrote.
 */
function inboxEventResolver(
  events: readonly AnyEventDefinition[]
): (inbox: InboxEvent) => InboxEventMatch {
  const byName = new Map(events.map((event) => [event.name, event]));
  const bySource = Map.groupBy(events, (event) => event.source.event);
  return (inbox) => {
    const named = byName.get(inbox.name);
    if (named !== undefined) return { kind: "event", event: named };
    const onSource = bySource.get(inbox.name);
    if (onSource === undefined) return { kind: "unknown" };
    const event = onSource.find(
      (candidate) =>
        candidate.source.when === undefined ||
        matchesSourceFilter(candidate.source.when, inbox.data)
    );
    return event === undefined
      ? { kind: "unmatched_source" }
      : { kind: "event", event };
  };
}

/**
 * One settling write of the pass. A refusal stops the pass as a lost lease,
 * so the pass answers it as the fence's refusal and writes nothing more.
 */
function watchedSettle(
  pass: DeliveryPass,
  write: Effect.Effect<void, DatabaseError | LeaseLost>
): Effect.Effect<void, DatabaseError | LeaseLost> {
  return write.pipe(
    Effect.tapError((failure) =>
      Effect.sync(() => {
        if (failure._tag === "LeaseLost") pass.state.leaseLost();
      })
    )
  );
}

export function deliveryBody(
  input: DeliverySettings & {
    /** The fan-out's halves. Defaults to the services `deliver-event.ts` exports. */
    deliver?: EventListenerDeliverPorts | undefined;
  }
): PassBody<DeliveryPass, ExecutionRepo> {
  const resolve = inboxEventResolver(input.events);
  const deliver = input.deliver ?? defaultDeliverPorts;

  return {
    open: (pass) =>
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const { fence } = pass;
        const failDelivery = (error: string) =>
          watchedSettle(
            pass,
            executions.failDelivery({ fence, error, now: pass.now() })
          );

        const inbox = yield* executions.findInboxEvent(fence.inboxId);
        // The schedule row goes with its inbox row by cascade, so a row the
        // retention sweep took between the claim and here leaves nothing.
        if (inbox === null) {
          return {
            kind: "unavailable",
            reason: "missing_inbox_event",
            settle: Effect.void,
          } satisfies OpenedBody<never>;
        }
        if (inbox.status !== "pending") {
          return {
            kind: "unavailable",
            reason: "inbox_event_settled",
            settle: pass.passWrites.dropSchedule(),
          } satisfies OpenedBody<never>;
        }

        const match = resolve(inbox);
        if (match.kind === "unknown") {
          const error = "No catalog Event or Event source has this name";
          return {
            kind: "unavailable",
            reason: "unknown_event",
            settle: failDelivery(error),
            detail: error,
          } satisfies OpenedBody<never>;
        }
        if (match.kind === "unmatched_source") {
          return {
            kind: "unavailable",
            reason: "unmatched_source",
            settle: watchedSettle(
              pass,
              executions.finishDelivery({ fence, now: pass.now() })
            ),
          } satisfies OpenedBody<never>;
        }

        const { event } = match;
        const decoded = yield* event.decodePayloadValue(inbox.data).pipe(
          Effect.match({
            onSuccess: (value) => ({ accepted: true as const, value }),
            onFailure: (rejection) => ({ accepted: false as const, rejection }),
          })
        );
        // A refusal is final: the same data fails the same way on every
        // attempt. The row keeps the sender's sentence, which quotes nothing
        // of the data, and the pass's record carries the operator's.
        if (!decoded.accepted) {
          const { rejection } = decoded;
          return {
            kind: "unavailable",
            reason: "payload_refused",
            settle: failDelivery(
              `Payload refused for Event "${event.name}": ${rejection.error}`
            ),
            detail: rejection.detail,
          } satisfies OpenedBody<never>;
        }

        return {
          kind: "ready",
          run: (steps) =>
            Effect.tryPromise({
              try: () =>
                runEventListener({
                  event,
                  payload: inbox.data,
                  validatedPayload: decoded.value,
                  arrival: { kind: "inbox", inboxId: inbox.id },
                  connectionId: inbox.connectionId ?? undefined,
                  runtime: input.runtime,
                  step: { run: (id, fn) => steps.run({ id }, fn) },
                  deliver,
                }),
              // The pass tells a step's spent retries from other failures by
              // the identity of what the step threw, which `failureFromUnknown`
              // keeps for a value that is already an engine failure.
              catch: failureFromUnknown,
            }).pipe(
              Effect.andThen(
                watchedSettle(
                  pass,
                  executions.finishDelivery({ fence, now: pass.now() })
                )
              ),
              Effect.as({ kind: "ended" as const })
            ),
        } satisfies OpenedBody<ExecutionRepo>;
      }),
    fail: (pass, error) =>
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        yield* watchedSettle(
          pass,
          executions.failDelivery({ fence: pass.fence, error, now: pass.now() })
        );
      }),
  };
}
