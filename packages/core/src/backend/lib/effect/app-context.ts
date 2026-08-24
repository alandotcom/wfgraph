import { Context, Layer } from "effect";

/** Stable host URLs that background services cannot derive from a request. */
export type WfGraphAppContextValue = {
  /** The normalized public origin. OAuth remains unavailable when it is absent. */
  readonly publicUrl?: string;
  /** The complete API mount path, such as `/wfgraph/api`. */
  readonly apiBasePath: `/${string}`;
};

export class WfGraphAppContext extends Context.Service<
  WfGraphAppContext,
  WfGraphAppContextValue
>()("@wfgraph/core/WfGraphAppContext") {}

export function makeAppContextLayer(
  value: WfGraphAppContextValue
): Layer.Layer<WfGraphAppContext> {
  return Layer.succeed(WfGraphAppContext, value);
}
