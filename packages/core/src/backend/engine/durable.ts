/**
 * The Effect↔Promise bridge at every durability boundary of the runtime.
 *
 * A durable callback is Promise-shaped, so an Effect that must run inside one
 * has to cross without losing its cause or the invocation context that owns
 * logging and tracing. Every engine site that calls `runtime.run` or
 * `runtime.runIdempotent` with an Effect goes through here.
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
  return crossInto((ref, fn) => runtime.run(ref, fn), step, effect);
}

/**
 * `runDurable` for an idempotent Effect, through `runtime.runIdempotent`: it
 * runs on every pass and its value is never stored.
 */
export function runIdempotentDurable<A, E>(
  runtime: WorkflowExecutionRuntime,
  step: DurableStepRef,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, EngineFailure> {
  return crossInto((ref, fn) => runtime.runIdempotent(ref, fn), step, effect);
}

/** Runs `effect` as the step `step` of one of the runtime's two step methods. */
function crossInto<A, E>(
  method: WorkflowExecutionRuntime["run"],
  step: DurableStepRef,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, EngineFailure> {
  return Effect.gen(function* () {
    const effectContext = yield* Effect.context();
    return yield* fromUnknownPromise(() =>
      method(step, () => runPromiseWithEngineFailure(effectContext)(effect))
    );
  });
}
