import { Context, Layer } from "effect";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";

/**
 * The assembled surface, as a service rather than module state.
 *
 * `createRovaApp` assembles one set and hands it to the Layer graph, so every
 * reader -- the credential mapping, the two workflow validators, the catalog
 * route, the Event listener set -- asks the runtime that owns it. An app that
 * never assembled a surface cannot provide this Layer, which is the throw the
 * module-level registry used to raise, moved into the type system: a service
 * body that yields this puts `Extensions` in its own `R`, and only a runtime
 * carrying one can run it.
 */
export class Extensions extends Context.Service<Extensions, ExtensionSet>()(
  "@rova/core/Extensions"
) {}

export function makeExtensionsLayer(
  set: ExtensionSet
): Layer.Layer<Extensions> {
  return Layer.succeed(Extensions, set);
}
