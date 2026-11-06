import { Context, Effect, Layer, Schema } from "effect";
import type { Inngest } from "inngest";
import { sendCatalogEvent } from "#src/backend/lib/inngest/runtime-events";

/**
 * Inngest refused a request, or never received it.
 *
 * `cause` is whatever the Inngest SDK threw, kept for the operator-facing log
 * the way `DatabaseError` keeps a rejected query. Nothing inspects it: a service
 * that could not forward an Event answers "internal", and the sentence the
 * caller reads comes from the cause's own message.
 */
export class InngestError extends Schema.TaggedError<
  InngestError,
  { readonly brand: unique symbol }
>()("InngestError", {
  cause: Schema.Defect(),
}) {}

/**
 * The Event bus, as a service rather than a module-level handle.
 *
 * Inngest delivers Events to the workflows subscribed to them, and that is the
 * one thing the services ask of it: forward a catalog Event so its listener
 * drives the fan-out durably. Workflow runs execute on the database executor,
 * which `ExecutionDriver` addresses. The send answers an Effect whose error
 * channel names `InngestError`, and a test provides its own send instead of
 * reaching a dev server.
 */
export class InngestClient extends Context.Service<
  InngestClient,
  {
    /**
     * Forward a host or integration Event so its listener drives the fan-out.
     * Carries `connectionId` on event data for integration-owned Events.
     */
    readonly sendCatalogEvent: (
      input: Parameters<typeof sendCatalogEvent>[1]
    ) => Effect.Effect<void, InngestError>;
  }
>()("@wfgraph/core/InngestClient") {}

/**
 * The live bus, over the client the app built.
 *
 * The send delegates to `backend/lib/inngest/runtime-events`, which owns the
 * event envelope and the idempotency key it carries. The client is a parameter
 * rather than a module lookup, so which connection a service sends on is
 * decided by the app that owns it.
 */
export function makeInngestClientLayer(
  client: Inngest
): Layer.Layer<InngestClient> {
  return Layer.succeed(InngestClient, {
    sendCatalogEvent: (input) =>
      Effect.tryPromise({
        try: async () => {
          await sendCatalogEvent(client, input);
        },
        catch: (cause) => new InngestError({ cause }),
      }),
  });
}

/**
 * The bus for a process that forwards no Event, such as the one
 * `createWfGraphRunner` starts. Only the webhook route forwards one, and that
 * process serves no route, so a send reaching this is a defect.
 */
export const unavailableInngestClientLayer: Layer.Layer<InngestClient> =
  Layer.succeed(InngestClient, {
    sendCatalogEvent: () =>
      Effect.die(
        new Error("This process has no Inngest client to forward Events on")
      ),
  });
