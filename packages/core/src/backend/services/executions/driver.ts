/**
 * `ExecutionDriver`: what a producer asks of the durable executor, by intent.
 * Each method commits its row write through `ExecutionRepo`, then, when the
 * write made a run due, wakes this process's worker loop and announces the run
 * to other processes. A lost wake costs at most one poll interval.
 */

import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { WorkerWake } from "#src/backend/executor/worker-wake";
import type { DatabaseError } from "#src/backend/lib/effect/database";
import type { WfGraphRunWakes } from "#src/backend/persistence/types";
import {
  ExecutionRepo,
  type ParkResolution,
  type ParkWake,
} from "#src/backend/services/executions/repo";

/**
 * The executor's storage refused a producer's write, or never received it.
 *
 * `cause` is what the database layer failed with, kept for the operator-facing
 * log the way `InngestError` keeps a refused send. A service answers it as
 * "internal".
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

export class ExecutionDriver extends Context.Service<
  ExecutionDriver,
  {
    /**
     * Give a started run its schedule row, due now. A second call for the
     * same run leaves the row as it stands, wherever the run has got to.
     */
    readonly enqueueRun: (input: {
      executionId: string;
    }) => Effect.Effect<void, DriverError>;
    /**
     * Resolve one park of a run with `wake` and re-queue the run, as
     * `ExecutionRepo.resolvePark` describes. Answers whether this call set the
     * wake and whether it re-queued the run; a run whose pass holds it is
     * re-queued by that pass's release instead.
     */
    readonly resolvePark: (input: {
      executionId: string;
      waitStateId: string;
      wake: ParkWake;
    }) => Effect.Effect<ParkResolution, DriverError>;
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
        enqueueRun: Effect.fn("ExecutionDriver.enqueueRun")(function* (input) {
          const inserted = yield* executions
            .scheduleExecution({
              executionId: input.executionId,
              kind: "run",
              wakeAt: yield* now,
            })
            .pipe(Effect.mapError(driverError));
          if (inserted) yield* runDue(input.executionId);
        }),

        resolvePark: Effect.fn("ExecutionDriver.resolvePark")(
          function* (input) {
            const resolution = yield* executions
              .resolvePark({ ...input, now: yield* now })
              .pipe(Effect.mapError(driverError));
            if (resolution.requeued) yield* runDue(input.executionId);
            return resolution;
          }
        ),

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
