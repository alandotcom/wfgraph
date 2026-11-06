/**
 * `ExecutionDriver`: what a producer asks of the durable executor, by intent.
 * Each method commits its row write through `ExecutionRepo` in one
 * transaction, then, when the write made a run due, wakes this process's
 * worker loop and announces the run to other processes. A lost wake costs at
 * most one poll interval.
 */

import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { WorkerWake } from "#src/backend/executor/worker-wake";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import type { WfGraphRunWakes } from "#src/backend/persistence/types";
import {
  type CanceledOutletClaim,
  type EntityStartOutcome,
  type ExecutionEntitySelector,
  ExecutionRepo,
  type StartForEntityInput,
  type WorkflowExecution,
} from "#src/backend/services/executions/repo";
import type { WaitResumeClaim } from "#src/backend/services/executions/repo/waits";
import type { WaitArrival } from "@wfgraph/shared/lifecycle/wait-signal";
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
 * row between the selection and the claim.
 */
export type ParkTarget =
  | { kind: "resume_token"; token: string }
  | {
      kind: "wait_state";
      waitStateId: string;
      token: string;
      eventName: string;
      /** Permit only an empty arrival slot or this arrival's own delivery id. */
      allowSameDeliveryRetry?: boolean | undefined;
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
     * and resolve it with `arrival` as a `resume` wake, re-queueing its run.
     * The claim and the wake are one write (`claimWaitingStateById` and
     * `claimWaitingStateByToken` in `ExecutionRepo`). Answers the park it
     * claimed, or null when no row could be claimed; a run whose pass holds it
     * is re-queued by that pass's release.
     */
    readonly resolvePark: (input: {
      target: ParkTarget;
      arrival: WaitArrival;
    }) => Effect.Effect<WaitResumeClaim | null, DriverError>;
    /**
     * Claim every in-flight run of one entity for its Canceled outlet,
     * resolving each run's parks with a `cancel` wake and re-queueing it, as
     * `ExecutionRepo.requestCancelForEntity` describes.
     */
    readonly requestCanceledOutlet: (
      input: {
        workflowId: string;
        runMode: WorkflowExecution["runMode"];
        eventName: string;
        payload: JsonObject;
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
     * Take a run back from the pass that holds it, for a run a policy cancel
     * ended. The terminal write already cancelled the run's open parks and
     * deleted its schedule row; when the row is still there, this clears its
     * lease token, so the pass's next write is refused, and makes the row due
     * now, so the next pass drops it. A run with no row is left alone.
     */
    readonly stopRun: (input: {
      executionId: string;
    }) => Effect.Effect<void, DriverError>;
  }
>()("@wfgraph/core/ExecutionDriver") {}

/**
 * Who the driver tells that a run fell due: `worker`, which the worker loop in
 * this process listens to, and the persistence backend's `wakes`, which reach
 * loops in other processes when the backend can.
 */
export type ExecutionDriverWakes = {
  worker: WorkerWake;
  persistence: WfGraphRunWakes;
};

/** The database driver, over the app's `ExecutionRepo`. */
export function makeExecutionDriverLayer(
  wakes: ExecutionDriverWakes
): Layer.Layer<ExecutionDriver, never, ExecutionRepo> {
  /** Runs once the write that made `executionId` due has committed. */
  const runDue = (executionId: string) =>
    Effect.sync(() => {
      wakes.worker.wake();
      if (wakes.persistence.kind === "notify") {
        wakes.persistence.broadcast.announce(executionId);
      }
    });

  return Layer.effect(
    ExecutionDriver,
    Effect.gen(function* () {
      const executions = yield* ExecutionRepo;
      return ExecutionDriver.of({
        startRun: Effect.fn("ExecutionDriver.startRun")(function* (input) {
          const outcome = yield* executions
            .startForEntity({ ...input, now: yield* now })
            .pipe(Effect.mapError(driverError));
          // A start answered with the row an earlier attempt committed wakes
          // the loops again, which costs one claim that may lease nothing.
          if (outcome.status === "started") {
            yield* runDue(outcome.execution.id);
          }
          return outcome;
        }),

        resolvePark: Effect.fn("ExecutionDriver.resolvePark")(
          function* (input) {
            const { target, arrival } = input;
            const at = yield* now;
            const claim = yield* (
              target.kind === "resume_token"
                ? executions.claimWaitingStateByToken({
                    resumeToken: target.token,
                    arrival,
                    now: at,
                  })
                : executions.claimWaitingStateById({
                    waitStateId: target.waitStateId,
                    resumeToken: target.token,
                    eventName: target.eventName,
                    allowSameDeliveryRetry: target.allowSameDeliveryRetry,
                    arrival,
                    now: at,
                  })
            ).pipe(Effect.mapError(driverError));
            if (claim?.requeued === true) {
              yield* runDue(claim.waitState.executionId);
            }
            return claim;
          }
        ),

        requestCanceledOutlet: Effect.fn(
          "ExecutionDriver.requestCanceledOutlet"
        )(function* (input) {
          const claims = yield* executions
            .requestCancelForEntity({ ...input, now: yield* now })
            .pipe(Effect.mapError(driverError));
          yield* Effect.forEach(
            claims.filter((claim) => claim.requeued),
            (claim) => runDue(claim.executionId)
          );
          return claims;
        }),

        migrateRun: Effect.fn("ExecutionDriver.migrateRun")(function* (input) {
          const moved = yield* executions
            .repinVersion({ ...input, now: yield* now })
            .pipe(Effect.mapError(driverError));
          // A leased run is re-queued by its release, so this wake can find
          // nothing due; it costs one claim that leases nothing.
          if (moved) yield* runDue(input.executionId);
          return moved;
        }),

        stopRun: Effect.fn("ExecutionDriver.stopRun")(function* (input) {
          const revoked = yield* executions
            .revokeLease({ executionId: input.executionId, now: yield* now })
            .pipe(Effect.mapError(driverError));
          if (revoked) yield* runDue(input.executionId);
        }),
      });
    })
  );
}
