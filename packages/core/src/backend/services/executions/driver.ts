/**
 * `ExecutionDriver`: what a producer asks of the durable executor, by intent.
 * Each method commits its row write through `ExecutionRepo` in one
 * transaction, then follows one rule: when the write made a schedule row due,
 * it announces that once to every wake sink the app handed it, which reach
 * this process's worker loop and, where the backend can, loops in other
 * processes. A lost wake costs at most one poll interval.
 */

import { Clock, Context, Effect, Layer, Schema } from "effect";
import type {
  DatabaseError,
  LeaseLost,
} from "#src/backend/lib/effect/database";
import type { RunWakeSink } from "#src/backend/services/executions/wakes";
import {
  type CanceledOutletClaim,
  type CronFire,
  type CronPassWrites,
  type FireCronTimerInput,
  type EntityStartOutcome,
  type ExecutionEntitySelector,
  ExecutionRepo,
  type InboxInsert,
  type NewInboxEvent,
  type StartForEntityInput,
  type WaitResumeClaim,
} from "#src/backend/services/executions/repo";
import type { JsonObject } from "@wfgraph/shared/types/json";

/**
 * The executor's storage refused a producer's write, or never received it.
 *
 * `cause` is what the database layer failed with, kept for the operator-facing
 * log. A service answers it as "internal".
 */
export class DriverError extends Schema.TaggedError<
  DriverError,
  { readonly brand: unique symbol }
>()("DriverError", {
  cause: Schema.Defect(),
}) {}

function driverError(error: DatabaseError): DriverError {
  return new DriverError({ cause: error.cause });
}

/** The current time, read from Effect's `Clock`. */
const now = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis));

/**
 * Which event park an Event or a manual resume addresses.
 *
 * A manual resume from the Runs view names the park's own token. An Event
 * delivery names the row it selected and the Event it is delivering, which the
 * claim requires the row to still be subscribed to: a Migration can re-park the
 * row between the selection and the claim. `deliveryId` is the delivery that
 * carried the Event, which the claim uses to recognise a retry of itself.
 */
export type ParkTarget =
  | { kind: "resume_token"; token: string }
  | {
      kind: "wait_state";
      waitStateId: string;
      token: string;
      eventName: string;
      deliveryId?: string | undefined;
    };

export class ExecutionDriver extends Context.Service<
  ExecutionDriver,
  {
    /**
     * Open a run with Concurrency applied, scheduled due now, as
     * `ExecutionRepo.startForEntity` describes. The execution row, its
     * schedule row and its "run started" entry commit together, and the
     * worker loops are woken once they have.
     */
    readonly startRun: (
      input: Omit<StartForEntityInput, "now">
    ) => Effect.Effect<EntityStartOutcome, DriverError>;
    /**
     * Claim the event park `target` addresses for an Event or a manual resume,
     * and resolve it with a `resume` wake carrying `payload`, making its run
     * due. The claim and the wake are one write (`claimWaitingStateById` and
     * `claimWaitingStateByToken` in `ExecutionRepo`). Answers the park it
     * claimed, or null when no row could be claimed; a run whose pass holds it
     * is re-queued by that pass's release.
     *
     * The run's next pass reads the wake from the row, so it owns the
     * Execution's running status, the timeline entry for the wake, and closing
     * the row.
     */
    readonly resolvePark: (input: {
      target: ParkTarget;
      /** What the Event or the Runs view sent, which the woken run reads back. */
      payload: JsonObject;
    }) => Effect.Effect<WaitResumeClaim | null, DriverError>;
    /**
     * Claim every in-flight run of one entity for its Canceled outlet,
     * resolving each run's parks with a `cancel` wake and re-queueing it, as
     * `ExecutionRepo.requestCancelForEntity` describes.
     */
    readonly requestCanceledOutlet: (
      input: {
        workflowId: string;
        eventName: string;
        payload: JsonObject;
        /** The arrival's inbox id, which a retried delivery is answered by. */
        deliveryId: string;
      } & ExecutionEntitySelector
    ) => Effect.Effect<CanceledOutletClaim[], DriverError>;
    /**
     * Move a parked run onto another Workflow Version, resolving its parks with
     * a `migrate` wake and re-queueing it, as `ExecutionRepo.repinVersion`
     * describes. Answers whether the run moved.
     */
    readonly migrateRun: (input: {
      executionId: string;
      fromVersionId: string;
      toVersionId: string;
      expectedWaitStates: readonly { id: string; resumeToken: string | null }[];
    }) => Effect.Effect<boolean, DriverError>;
    /**
     * Record an arrival in the event inbox with its delivery schedule row, due
     * now, as `ExecutionRepo.insertInboxEvent` describes, and wake the worker
     * loops once a new arrival has committed. A duplicate wakes nothing.
     */
    readonly receiveEvent: (
      input: NewInboxEvent
    ) => Effect.Effect<InboxInsert, DriverError>;
    /**
     * Fire a cron pass's leased timer through the pass's own `writes`, as
     * `CronPassWrites.fireCronTimer` describes, and wake the worker loops
     * once a fire that opened a run has committed. The write is the pass's,
     * so its fence and its watch on the lease are the pass's too, and
     * `LeaseLost` answers a pass whose timer no longer names its lease. The
     * fire reads the pass's clock from `input.now` rather than this service's.
     */
    readonly fireCronTimer: (
      input: FireCronTimerInput & { writes: CronPassWrites }
    ) => Effect.Effect<CronFire, DriverError | LeaseLost>;
  }
>()("@wfgraph/core/ExecutionDriver") {}

/** The database driver, over the app's `ExecutionRepo`. */
export function makeExecutionDriverLayer(
  /** Told once per committed write that made a schedule row due. */
  sinks: readonly RunWakeSink[]
): Layer.Layer<ExecutionDriver, never, ExecutionRepo> {
  /**
   * Runs once a write has committed, and wakes the loops when `madeDue` says
   * it made a schedule row due.
   */
  const runDue = (madeDue: boolean) =>
    Effect.sync(() => {
      if (!madeDue) return;
      for (const sink of sinks) sink.announce();
    });

  return Layer.effect(
    ExecutionDriver,
    Effect.gen(function* () {
      const executions = yield* ExecutionRepo;
      return ExecutionDriver.of({
        startRun: Effect.fn("wfgraph.driver.start_run")(function* (input) {
          yield* Effect.annotateCurrentSpan(
            "wfgraph.workflow.id",
            input.execution.workflowId
          );
          const outcome = yield* executions
            .startForEntity({ ...input, now: yield* now })
            .pipe(Effect.mapError(driverError));
          yield* Effect.annotateCurrentSpan("wfgraph.outcome", outcome.status);
          // A start answered with the row an earlier attempt committed wakes
          // the loops again, which costs one claim that may lease nothing.
          if (outcome.status === "started") {
            yield* Effect.annotateCurrentSpan(
              "wfgraph.execution.id",
              outcome.execution.id
            );
            yield* runDue(true);
          }
          return outcome;
        }),

        resolvePark: Effect.fn("wfgraph.driver.resolve_park")(
          function* (input) {
            const { target, payload } = input;
            if (target.kind === "wait_state") {
              yield* Effect.annotateCurrentSpan(
                "wfgraph.wait.id",
                target.waitStateId
              );
            }
            const at = yield* now;
            const claim = yield* (
              target.kind === "resume_token"
                ? executions.claimWaitingStateByToken({
                    resumeToken: target.token,
                    arrival: { eventName: null, payload },
                    now: at,
                  })
                : executions.claimWaitingStateById({
                    waitStateId: target.waitStateId,
                    resumeToken: target.token,
                    eventName: target.eventName,
                    arrival: {
                      eventName: target.eventName,
                      payload,
                      deliveryId: target.deliveryId,
                    },
                    now: at,
                  })
            ).pipe(Effect.mapError(driverError));
            if (claim !== null) {
              yield* Effect.annotateCurrentSpan({
                "wfgraph.execution.id": claim.waitState.executionId,
                "wfgraph.wait.id": claim.waitState.id,
                "wfgraph.driver.requeued": claim.requeued,
              });
            }
            yield* runDue(claim?.requeued === true);
            return claim;
          }
        ),

        // One write claims the whole batch, so its runs are announced once.
        requestCanceledOutlet: Effect.fn(
          "wfgraph.driver.request_canceled_outlet"
        )(function* (input) {
          yield* Effect.annotateCurrentSpan(
            "wfgraph.workflow.id",
            input.workflowId
          );
          const claims = yield* executions
            .requestCancelForEntity({ ...input, now: yield* now })
            .pipe(Effect.mapError(driverError));
          yield* Effect.annotateCurrentSpan({
            "wfgraph.execution.ids": claims.map((claim) => claim.executionId),
            "wfgraph.driver.claims": claims.length,
          });
          yield* runDue(
            claims.some((claim) => claim.kind === "claimed" && claim.requeued)
          );
          return claims;
        }),

        migrateRun: Effect.fn("wfgraph.driver.migrate_run")(function* (input) {
          yield* Effect.annotateCurrentSpan({
            "wfgraph.execution.id": input.executionId,
            "wfgraph.workflow.version.id": input.fromVersionId,
            "wfgraph.workflow.version.target_id": input.toVersionId,
          });
          const repinned = yield* executions
            .repinVersion({ ...input, now: yield* now })
            .pipe(Effect.mapError(driverError));
          yield* Effect.annotateCurrentSpan(
            "wfgraph.driver.moved",
            repinned.moved
          );
          yield* runDue(repinned.moved && repinned.requeued);
          return repinned.moved;
        }),

        receiveEvent: Effect.fn("wfgraph.driver.receive_event")(
          function* (input) {
            yield* Effect.annotateCurrentSpan("wfgraph.event.name", input.name);
            const inserted = yield* executions
              .insertInboxEvent({ ...input, now: yield* now })
              .pipe(Effect.mapError(driverError));
            yield* Effect.annotateCurrentSpan({
              "wfgraph.inbox.id": inserted.inboxId,
              "wfgraph.inbox.duplicate": inserted.duplicate,
            });
            yield* runDue(!inserted.duplicate);
            return inserted;
          }
        ),

        fireCronTimer: Effect.fn("wfgraph.driver.fire_cron_timer")(function* ({
          writes,
          ...input
        }) {
          yield* Effect.annotateCurrentSpan(
            "wfgraph.workflow.id",
            input.start.execution.workflowId
          );
          const fired = yield* writes
            .fireCronTimer(input)
            .pipe(
              Effect.catchTag("DatabaseError", (error) =>
                Effect.fail(driverError(error))
              )
            );
          yield* Effect.annotateCurrentSpan(
            "wfgraph.outcome",
            fired.kind === "fired" ? fired.start.status : fired.kind
          );
          const opened =
            fired.kind === "fired" && fired.start.status === "started"
              ? fired.start.execution
              : null;
          if (opened !== null) {
            yield* Effect.annotateCurrentSpan(
              "wfgraph.execution.id",
              opened.id
            );
          }
          yield* runDue(opened !== null);
          return fired;
        }),
      });
    })
  );
}
