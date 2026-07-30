import { Context, Effect, Layer, Schema } from "effect";
import {
  sendHostEvent,
  sendWorkflowCancelRequested,
  sendWorkflowRunRequested,
  sendWorkflowWaitSignal,
} from "#src/backend/lib/inngest/runtime-events";

/**
 * Inngest refused a request, or never received it.
 *
 * `cause` is whatever the Inngest SDK threw, kept for the operator-facing log
 * the way `DatabaseError` keeps a rejected query. Nothing inspects it: a service
 * that could not enqueue a run answers "internal", and the sentence the caller
 * reads comes from the cause's own message.
 */
export class InngestError extends Schema.TaggedErrorClass<InngestError>()(
  "InngestError",
  {
    cause: Schema.Defect(),
  }
) {}

/**
 * The event bus that drives runs, as a service rather than a module-level
 * handle.
 *
 * Four sends is the whole of what the services ask Inngest for: start a run,
 * cancel one, wake a waiting one, and forward a host's Event so its listener
 * drives the fan-out durably. Each answers an Effect whose error channel names
 * `InngestError`, so a service that enqueues can no longer forget that
 * enqueueing fails, and a test provides its own sends instead of reaching a
 * dev server.
 */
export class InngestClient extends Context.Service<
  InngestClient,
  {
    /** Enqueue a run. The event id it answers with is the run id we store. */
    readonly sendRunRequested: (
      data: Parameters<typeof sendWorkflowRunRequested>[0]
    ) => Effect.Effect<
      Awaited<ReturnType<typeof sendWorkflowRunRequested>>,
      InngestError
    >;
    /** Ask the run's function to stop; its `cancelOn` does the rest. */
    readonly sendCancelRequested: (
      input: Parameters<typeof sendWorkflowCancelRequested>[0]
    ) => Effect.Effect<void, InngestError>;
    /** Wake one waiting node with the payload that arrived for it. */
    readonly sendWaitSignal: (
      input: Parameters<typeof sendWorkflowWaitSignal>[0]
    ) => Effect.Effect<void, InngestError>;
    /** Put a posted Event on the bus, for its own listener to fan out. */
    readonly sendHostEvent: (
      input: Parameters<typeof sendHostEvent>[0]
    ) => Effect.Effect<void, InngestError>;
  }
>()("InngestClient") {}

const send = <A>(run: () => Promise<A>): Effect.Effect<A, InngestError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InngestError({ cause }),
  });

/**
 * The live bus.
 *
 * The three sends delegate to `backend/lib/inngest/runtime-events`, which owns
 * the event envelopes and the idempotency key each one carries, and which
 * reaches the process-global client through `getInngestClient()`. Stage 7 of
 * ADR-0002 builds that client inside `createRovaApp` and hands it to this Layer,
 * at which point the global goes away and this file is the only thing that
 * changes.
 */
export const InngestClientLayer: Layer.Layer<InngestClient> = Layer.succeed(
  InngestClient,
  {
    sendRunRequested: (data) => send(() => sendWorkflowRunRequested(data)),
    sendCancelRequested: (input) =>
      send(async () => {
        await sendWorkflowCancelRequested(input);
      }),
    sendWaitSignal: (input) =>
      send(async () => {
        await sendWorkflowWaitSignal(input);
      }),
    sendHostEvent: (input) => send(() => sendHostEvent(input)),
  }
);

/**
 * Run a call into one of the `backend/lib/workflow-*` helpers that drives runs
 * through Inngest, and give it the same typed error channel a send gets.
 *
 * `cancelInFlightRuns` and `resumeWaitsMatchingEvent` each mix a send with the
 * wait-state bookkeeping around it, so neither belongs behind a repository and
 * neither is reachable through the three sends above. This is the seam they
 * cross until stage 7 brings the run engine itself onto Effect, and it mirrors
 * `callDbModule` for the modules that only query.
 */
export const callInngestModule = <A>(
  run: () => Promise<A>
): Effect.Effect<A, InngestError> => send(run);
