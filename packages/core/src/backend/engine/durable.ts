/**
 * The Effect↔Promise bridge at every durability boundary of the runtime.
 *
 * A durable callback is Promise-shaped, so an Effect that must run inside one
 * has to cross without losing its cause or the invocation context that owns
 * logging and tracing. Every engine site that calls `runtime.run` or
 * `runtime.runIdempotent` with an Effect goes through here. The step's Effect
 * runs with `CurrentDurableStep` naming the step, and stops when the runtime
 * aborts the signal it hands the step. Interrupting the engine fiber that
 * waits on the step does not stop it, since a sibling branch's failure
 * interrupts that fiber and a step already started must finish for the
 * runtime to remember its value.
 */

import { Context, Effect } from "effect";
import {
  type EngineFailure,
  failureFromUnknown,
  runPromiseWithEngineFailure,
} from "#src/backend/engine/engine-failure";
import type {
  DurableStepRef,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";

/**
 * The durable step whose Effect is running, or null outside any step. A
 * runtime reads it to tell which step a write made inside a step belongs to.
 */
export const CurrentDurableStep = Context.Reference<DurableStepRef | null>(
  "wfgraph/engine/CurrentDurableStep",
  { defaultValue: () => null }
);

/**
 * Lift a Promise into the engine failure channel. The Promise is not told
 * when the fiber awaiting it is interrupted, so it runs on detached.
 */
export function fromUnknownPromise<A>(
  evaluate: () => Promise<A>
): Effect.Effect<A, EngineFailure> {
  return Effect.tryPromise({
    try: () => evaluate(),
    catch: failureFromUnknown,
  });
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
    const inStep = Effect.provideService(effect, CurrentDurableStep, step);
    return yield* fromUnknownPromise(() =>
      method(step, (signal) =>
        runPromiseWithEngineFailure(effectContext)(inStep, { signal })
      )
    );
  });
}
