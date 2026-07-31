/**
 * What a package of integrations may use from Rova's server.
 *
 * `@rova/plugins` builds against this and nothing else, so an outside
 * integration package can be written the same way. Anything added here is a
 * promise; add it only when a plugin cannot be written without it.
 *
 * What is below is the whole of it, for a file that runs on the server. An
 * integration is a `defineIntegration` holding its credential fields and a
 * `defineStep` per action; a step is an input schema, an output schema, the
 * metadata the editor draws the action with, and a handler that fails with a
 * `StepFailure`; and a connection test, which answers the credentials UI over a
 * Promise rather than inside a handler, provides `VendorTransport` itself. There
 * is nothing to register: an integration is a value a host passes to
 * `createRovaApp`, and the credential fetch and the run logging are
 * `defineStep`'s business.
 */

export type {
  IntegrationTestFunction,
  IntegrationTestResult,
} from "#src/backend/extensions/integration-test";
export {
  checkIntegration,
  credentialFields,
  type CredentialsOf,
  defineIntegration,
  type IntegrationDefinition,
} from "#src/backend/extensions/define-integration";
export {
  type ActionStep,
  defineStep,
  StepFailure,
  type StepRunContext,
} from "#src/backend/extensions/steps/define-step";
/**
 * The failure a credential read can end in, for a helper that yields
 * `context.credentials` and annotates what it answers. A plugin never builds
 * one: it names the type and passes the failure on.
 */
export type { CredentialsUnavailable } from "#src/backend/extensions/credential-fetcher";
/**
 * The `@rova/shared` vocabulary a server-side plugin file needs beside the
 * above: the JSON type a vendor payload decodes to and the reader that gets it
 * there, the Effect Schema helper for a value already typed as JSON, the
 * error-message helper for a caught exception, and the output-field derivation
 * an integration's own tests run. A browser file (an integration's `ui.ts`, or a
 * custom output renderer) does not import this entry point at all, since it must
 * not pull the backend graph into the client bundle; it reaches
 * `@rova/shared/plugins/ui-registry` directly instead.
 */
export {
  type JsonObject,
  type JsonValue,
  readJsonValue,
} from "@rova/shared/types/json";
export { readAs } from "@rova/shared/types/schema";
export { isoTimestampString } from "@rova/shared/types/timestamp";
export { getErrorMessage } from "@rova/shared/utils";
export { requireOutputFieldsFromSchema } from "@rova/shared/graph/output-fields";
/**
 * The layer a `defineStep` handler already runs with, exported for the calls a
 * plugin makes outside one: a connection test answers the credentials UI over a
 * Promise, so it enters the runtime and provides the transport itself. One
 * definition rather than a copy per package, because the `Context.Reference`
 * caching it works around is the kind of thing that gets fixed in one copy and
 * not the other.
 */
export { VendorTransport } from "#src/backend/extensions/steps/vendor-transport";
