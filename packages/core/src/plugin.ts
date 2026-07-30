/**
 * What a package of integrations may use from Rova's server.
 *
 * `@rova/plugins` builds against this and nothing else, so an outside
 * integration package can be written the same way. Anything added here is a
 * promise; add it only when a plugin cannot be written without it.
 *
 * What is below is the whole of it. An integration is a `defineIntegration`
 * holding its credential fields and a `defineStep` per action; a step is an input
 * schema, an output schema, the metadata the editor draws the action with, and a
 * handler that fails with a `StepFailure`; and a connection test, which answers
 * the credentials UI over a Promise rather than inside a handler, provides
 * `VendorTransport` itself. There is nothing to register: an integration is a
 * value a host passes to `createRovaApp`, and the credential fetch and the run
 * logging a plugin used to reach for are `defineStep`'s business.
 */

export type {
  IntegrationTestFunction,
  IntegrationTestResult,
} from "#src/backend/lib/extensions/integration-test";
export {
  checkIntegration,
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  type IntegrationDefinition,
} from "#src/backend/lib/extensions/define-integration";
export {
  type ActionStep,
  defineStep,
  StepFailure,
  type StepRunContext,
} from "#src/backend/lib/steps/define-step";
/**
 * The layer a `defineStep` handler already runs with, exported for the calls a
 * plugin makes outside one: a connection test answers the credentials UI over a
 * Promise, so it enters the runtime and provides the transport itself. One
 * definition rather than a copy per package, because the `Context.Reference`
 * caching it works around is the kind of thing that gets fixed in one copy and
 * not the other.
 */
export { VendorTransport } from "#src/backend/lib/steps/vendor-transport";
