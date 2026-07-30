import { Context, Effect, Layer } from "effect";
import type { InngestFunctionRegistry } from "#src/backend/lib/inngest/functions";

/**
 * The app's Inngest function list, as the one thing a service may do to it.
 *
 * Saving, duplicating or deleting a workflow changes which run functions
 * Inngest should know about, so those three drop the list and the next
 * `/inngest` request rebuilds it. The registry itself belongs to the app rather
 * than to a module, and this service is how a service body reaches it: a test
 * hands over a Layer that records the call instead of mocking an import.
 */
export class InngestFunctions extends Context.Service<
  InngestFunctions,
  {
    /** Forget the function list, including a build still in flight. */
    readonly invalidate: Effect.Effect<void>;
  }
>()("InngestFunctions") {}

/** The whole of what a write does to the list, as one name to yield. */
export const invalidateInngestFunctions: Effect.Effect<
  void,
  never,
  InngestFunctions
> = Effect.flatMap(InngestFunctions, (functions) => functions.invalidate);

export function makeInngestFunctionsLayer(
  registry: Pick<InngestFunctionRegistry, "invalidate">
): Layer.Layer<InngestFunctions> {
  return Layer.succeed(InngestFunctions, {
    invalidate: Effect.sync(() => {
      registry.invalidate();
    }),
  });
}
