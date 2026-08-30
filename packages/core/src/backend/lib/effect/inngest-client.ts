import { Context, Effect, Layer, Schema } from "effect";
import type { Inngest } from "inngest";
import {
  sendCatalogEvent,
  sendWorkflowBranchKill,
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
export class InngestError extends Schema.TaggedError<InngestError>()(
  "InngestError",
  {
    cause: Schema.Defect(),
  }
) {}

/**
 * The event bus that drives runs, as a service rather than a module-level
 * handle.
 *
 * Five sends is the whole of what the services ask Inngest for: start a run,
 * cancel one, kill the branch invocations of one, wake a waiting one, and
 * forward a catalog Event so its listener drives the fan-out durably. Each
 * answers an Effect whose error channel names `InngestError`, so a service that
 * enqueues cannot forget that enqueueing fails, and a test provides its own
 * sends instead of reaching a dev server.
 */
export class InngestClient extends Context.Service<
  InngestClient,
  {
    /** Enqueue a run. The event id it answers with is the run id we store. */
    readonly sendRunRequested: (
      data: Parameters<typeof sendWorkflowRunRequested>[1]
    ) => Effect.Effect<
      Awaited<ReturnType<typeof sendWorkflowRunRequested>>,
      InngestError
    >;
    /** Ask the run's function to stop; its `cancelOn` does the rest. */
    readonly sendCancelRequested: (
      input: Parameters<typeof sendWorkflowCancelRequested>[1]
    ) => Effect.Effect<void, InngestError>;
    /** Wake one waiting node with the payload that arrived for it. */
    readonly sendWaitSignal: (
      input: Parameters<typeof sendWorkflowWaitSignal>[1]
    ) => Effect.Effect<void, InngestError>;
    /**
     * Kill one run's branch invocations. The run itself survives, which is what
     * separates this from `sendCancelRequested`: it is the thing that closes
     * the rows they left open and routes the Execution.
     */
    readonly sendBranchKill: (
      input: Parameters<typeof sendWorkflowBranchKill>[1]
    ) => Effect.Effect<void, InngestError>;
    /**
     * Forward a host or integration Event so its listener drives the fan-out.
     * Carries `user.connectionId` for integration-owned Events.
     */
    readonly sendCatalogEvent: (
      input: Parameters<typeof sendCatalogEvent>[1]
    ) => Effect.Effect<void, InngestError>;
  }
>()("@wfgraph/core/InngestClient") {}

const send = <A>(run: () => Promise<A>): Effect.Effect<A, InngestError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InngestError({ cause }),
  });

/**
 * The live bus, over the client the app built.
 *
 * The three sends delegate to `backend/lib/inngest/runtime-events`, which owns
 * the event envelopes and the idempotency key each one carries. The client is a
 * parameter rather than a module lookup, so which connection a service sends on
 * is decided by the app that owns it.
 */
export function makeInngestClientLayer(
  client: Inngest
): Layer.Layer<InngestClient> {
  return Layer.succeed(InngestClient, {
    sendRunRequested: (data) =>
      send(() => sendWorkflowRunRequested(client, data)),
    sendCancelRequested: (input) =>
      send(async () => {
        await sendWorkflowCancelRequested(client, input);
      }),
    sendWaitSignal: (input) =>
      send(async () => {
        await sendWorkflowWaitSignal(client, input);
      }),
    sendBranchKill: (input) =>
      send(async () => {
        await sendWorkflowBranchKill(client, input);
      }),
    sendCatalogEvent: (input) =>
      send(async () => {
        await sendCatalogEvent(client, input);
      }),
  });
}
