/**
 * What a package of integrations may use from Rova's server.
 *
 * `@rova/plugins` builds against this and nothing else, so an outside
 * integration package can be written the same way. Anything added here is a
 * promise; add it only when a plugin cannot be written without it.
 *
 * A step is written with `defineStep` and registered with `registerStep`. The
 * last three names are what a step that has not moved to `defineStep` yet still
 * needs; stage 6b of ADR-0002 is where the last of them goes, and they go with
 * it.
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

export { registerStepFunction } from "#src/backend/lib/step-registry";
export { fetchCredentials } from "#src/backend/lib/credential-fetcher";
export {
  type StepInput,
  withStepLogging,
} from "#src/backend/lib/steps/step-handler";
