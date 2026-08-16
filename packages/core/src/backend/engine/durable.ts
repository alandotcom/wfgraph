/**
 * The Effect↔Promise bridge at every Inngest durability boundary.
 *
 * A durable callback is Promise-shaped, so an Effect that must run inside one
 * has to cross without losing its cause or the invocation context that owns
 * logging and tracing. Every engine site that calls `runtime.run` with an
 * Effect goes through here.
 */

import { Effect } from "effect";
import {
  type EngineFailure,
  failureFromUnknown,
  runPromiseWithEngineFailure,
} from "#src/backend/engine/engine-failure";
import type {
  DurableStepRef,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";

/** Lift a Promise into the engine failure channel. */
export function fromUnknownPromise<A>(
  evaluate: () => Promise<A>
): Effect.Effect<A, EngineFailure> {
  return Effect.tryPromise({ try: evaluate, catch: failureFromUnknown });
}

/**
 * Run an Effect inside a durable Promise callback, preserving cause and the
 * current Effect context across the seam.
 */
export function runDurable<A, E>(
  runtime: WorkflowExecutionRuntime,
  step: DurableStepRef,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, EngineFailure> {
  return Effect.gen(function* () {
    const effectContext = yield* Effect.context();
    return yield* fromUnknownPromise(() =>
      runtime.run(step, () =>
        runPromiseWithEngineFailure(effectContext)(effect)
      )
    );
  });
}

/**
 * Like `runDurable`, but the memoized step value is `null` so a void Effect
 * stays JSON-safe across Inngest's replay boundary.
 */
export function runDurableUnit<E>(
  runtime: WorkflowExecutionRuntime,
  step: DurableStepRef,
  effect: Effect.Effect<void, E>
): Effect.Effect<null, EngineFailure> {
  return runDurable(runtime, step, Effect.as(effect, null));
}
