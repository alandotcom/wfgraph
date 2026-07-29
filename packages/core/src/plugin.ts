/**
 * What a package of integrations may use from Rova's server.
 *
 * `@rova/plugins` builds against this and nothing else, so an outside
 * integration package can be written the same way. Anything added here is a
 * promise; add it only when a plugin cannot be written without it.
 *
 * What is below is the whole of it. A step is a `defineStep` over an input
 * schema, an output schema and a handler; it fails with a `StepFailure`; it is
 * registered with `registerStep` under the id it declares; and a connection
 * test, which answers the credentials UI over a Promise rather than inside a
 * handler, provides `VendorTransport` itself. The credential fetch and the run
 * logging a plugin used to reach for are `defineStep`'s business now, so they
 * are not here.
 */

export {
  defineStep,
  StepFailure,
  type StepDefinition,
  type StepRunContext,
} from "#src/backend/lib/steps/define-step";
export { registerStep } from "#src/backend/lib/step-registry";
export { registerIntegrationTest } from "#src/backend/services/integrations/integration-test-loaders";
/**
 * The layer a `defineStep` handler already runs with, exported for the calls a
 * plugin makes outside one: a connection test answers the credentials UI over a
 * Promise, so it enters the runtime and provides the transport itself. One
 * definition rather than a copy per package, because the `Context.Reference`
 * caching it works around is the kind of thing that gets fixed in one copy and
 * not the other.
 */
export { VendorTransport } from "#src/backend/lib/steps/vendor-transport";
