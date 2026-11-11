/**
 * The pass body of a `delivery` schedule row: load the arrival's inbox row,
 * tell which catalog Event it is (`ExtensionSet.resolveArrival`, read from
 * the `Extensions` service), gate its data through that Event's schema, and
 * fan it out with `fanOutDelivery` on the pass's step port. A delivery that
 * reached every workflow marks the inbox row `delivered` and writes the
 * delivery's one record. One whose row names no Event, whose data the Event
 * refuses, whose own step spent its retries, or that failed for good for some
 * of its workflows marks the row `failed` with the reason, so the poll never
 * schedules it again. Each settling write deletes the schedule row.
 */

import { Effect } from "effect";
import { payloadRejectionFields } from "#src/backend/extensions/define-event";
import type {
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import { Extensions } from "#src/backend/lib/effect/extensions";
import {
  decodeArrival,
  deliverEventPorts,
  type DeliverySummary,
  fanOutDelivery,
} from "#src/backend/executor/delivery-fanout";
import {
  type DeliveryPass,
  type OpenedBody,
  type PassBody,
  passAnnotations,
} from "#src/backend/executor/pass";
import type { PassSteps } from "#src/backend/executor/runtime";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

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

/** How many failed workflows an inbox row's error names before it counts the rest. */
const NAMED_FAILURES = 3;

/**
 * The error a partly delivered row settles with: how many workflows the Event
 * reached, and each failed workflow with the step that failed and its error.
 */
function partialDeliveryError(summary: DeliverySummary): string {
  const { failures } = summary;
  const named = failures
    .slice(0, NAMED_FAILURES)
    .map(
      (failure) =>
        `workflow ${failure.workflowId} (${failure.stage === "lifecycle" ? "Lifecycle Rules" : "Waits"}): ${failure.error}`
    );
  const unnamed = failures.length - named.length;
  const rest = unnamed > 0 ? `; and ${unnamed} more` : "";
  return `Delivered to ${summary.workflows - failures.length} of ${summary.workflows} workflows. Failed on every retry: ${named.join("; ")}${rest}`;
}

/**
 * Every service a delivery's pass reads: the inbox and the catalog, and what
 * its fan-out reads through `deliverEventPorts`.
 */
export type DeliveryServices =
  | ExecutionRepo
  | Extensions
  | Effect.Services<ReturnType<typeof fanOutDelivery>>;

export function deliveryBody(): PassBody<DeliveryPass, DeliveryServices> {
  return {
    open: (pass) =>
      Effect.gen(function* () {
        const executions = yield* ExecutionRepo;
        const extensions = yield* Extensions;
        const { fence } = pass;
        const failDelivery = (error: string) =>
          watchedSettle(
            pass,
            executions.failDelivery({ fence, error, now: pass.now() })
          );
        const finishDelivery = watchedSettle(
          pass,
          executions.finishDelivery({ fence, now: pass.now() })
        );

        const inbox = yield* executions.findInboxEvent(fence.inboxId);
        // The schedule row goes with its inbox row by cascade, so a row the
        // retention sweep took between the claim and here leaves nothing.
        if (inbox === null) {
          return {
            kind: "unavailable",
            reason: "missing_inbox_event",
            severity: "info",
            settle: Effect.void,
          } satisfies OpenedBody<never, never>;
        }
        if (inbox.status !== "pending") {
          return {
            kind: "unavailable",
            reason: "inbox_event_settled",
            severity: "info",
            settle: pass.passWrites.dropSchedule(),
          } satisfies OpenedBody<never, never>;
        }

        // How the row's name resolved, and to which catalog Event. A name that
        // resolves to none stays off the span, since its sender wrote it.
        const match = extensions.resolveArrival(inbox);
        yield* Effect.annotateCurrentSpan(
          "wfgraph.event.match",
          match.kind === "event" ? `by_${match.via}` : match.kind
        );
        if (match.kind === "event") {
          yield* Effect.annotateCurrentSpan(
            "wfgraph.event.name",
            match.event.name
          );
        }
        if (match.kind === "unknown") {
          const error =
            inbox.connectionId === null
              ? "No host Event or host Event source has this name"
              : "No integration-owned Event or Event source has this name";
          return {
            kind: "unavailable",
            reason: "unknown_event",
            severity: "warn",
            settle: failDelivery(error),
            detail: error,
          } satisfies OpenedBody<never, never>;
        }
        if (match.kind === "unmatched_source") {
          return {
            kind: "unavailable",
            reason: "unmatched_source",
            severity: "info",
            settle: finishDelivery,
          } satisfies OpenedBody<never, never>;
        }

        const { event } = match;
        const decoded = yield* decodeArrival(event, inbox.data).pipe(
          Effect.result
        );
        // A refusal is final: the same data fails the same way on every
        // attempt. The row keeps the sender's sentence, which quotes nothing
        // of the data, and the pass's record carries the issue count and paths.
        if (decoded._tag === "Failure") {
          const rejection = decoded.failure;
          const { issues, paths } = payloadRejectionFields(rejection);
          return {
            kind: "unavailable",
            reason: "payload_refused",
            severity: "warn",
            settle: failDelivery(
              `Payload refused for Event "${event.name}": ${rejection.error}`
            ),
            detail: `${issues} payload issue(s) at: ${paths.join(", ")}`,
          } satisfies OpenedBody<never, never>;
        }

        return {
          kind: "ready",
          run: (steps: PassSteps) =>
            Effect.gen(function* () {
              const summary = yield* fanOutDelivery({
                arrival: decoded.success,
                inboxId: inbox.id,
                connectionId: inbox.connectionId,
                attempt: pass.claimed.attempt,
                steps,
                ports: deliverEventPorts,
              });
              // A workflow that failed for good leaves the row `failed`, the
              // status a resend of its key reopens, while every other
              // workflow has received the Event.
              yield* summary.failures.length > 0
                ? failDelivery(partialDeliveryError(summary))
                : finishDelivery;
              // The delivery's one record, written once its row has settled.
              yield* (
                summary.failures.length > 0
                  ? Effect.logWarning("Delivered an event to some workflows")
                  : Effect.logInfo("Delivered an event")
              ).pipe(
                Effect.annotateLogs({
                  ...passAnnotations(pass.claimed, pass.workerId),
                  event: { name: event.name },
                  outcome: {
                    workflows: summary.workflows,
                    started: summary.started,
                    canceled: summary.canceled,
                    resumedWaits: summary.resumedWaits,
                    failed: summary.failures.length,
                  },
                })
              );
              return { kind: "ended" as const };
            }),
        } satisfies OpenedBody<PassSteps, DeliveryServices>;
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
