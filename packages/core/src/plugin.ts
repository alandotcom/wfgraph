/**
 * What a package of integrations may use from Rova's server.
 *
 * `@rova/plugins` builds against this and nothing else, so an outside
 * integration package can be written the same way. Anything added here is a
 * promise; add it only when a plugin cannot be written without it.
 *
 * What is below is the whole of it, for a file that runs on the server. An
 * integration is one `defineIntegration` call: a credential record, and an
 * action per record key holding an input schema, an output schema, the metadata
 * the editor draws it with, and a handler. A connection test answers the
 * credentials UI over a Promise, so it calls out through `callExternalAsync`.
 * There is nothing to register: an integration is a value a host passes to
 * `createRovaApp`, and the credential fetch and the run logging are
 * `defineIntegration`'s business.
 *
 * An integration's own suite drives an action through `@rova/core/testing`,
 * which is a separate entry because nothing in it runs in a server.
 *
 * Effect is optional here. Schemas may come from any Standard Schema library and
 * a handler may be an `async` function, so an integration can be written without
 * importing Effect at all. Everything Effect-shaped below serves the arm that
 * wants it: `StepFailure` is how an Effect handler fails, and `callExternal` is
 * the one an Effect handler yields.
 */

export type {
  IntegrationTestFunction,
  IntegrationTestResult,
} from "#src/backend/extensions/integration-test";
export {
  checkIntegration,
  type CredentialsOf,
  defineIntegration,
  type Integration,
  type IntegrationDefinition,
} from "#src/backend/extensions/define-integration";
export type { CredentialFields } from "@rova/shared/extensions/catalog";
export {
  type StepBag,
  StepFailure,
} from "#src/backend/extensions/steps/define-step";
/**
 * The failure a credential read can end in, for a helper that yields
 * `context.credentials` and annotates what it answers. A plugin never builds
 * one: it names the type and passes the failure on.
 */
export type { CredentialsUnavailable } from "#src/backend/extensions/credential-fetcher";
/**
 * The `@rova/shared` vocabulary a server-side plugin file needs beside the
 * above: the JSON type an external payload decodes to and the reader that gets
 * it there, the Effect Schema helper for a value already typed as JSON, the
 * error-message helper for a caught exception, and the output-field derivation
 * an integration's own tests run. A browser file (an integration's icon, or a
 * custom output renderer) does not import this entry point at all, since it must
 * not pull the backend graph into the client bundle.
 */
export {
  type JsonObject,
  type JsonValue,
  readJsonValue,
} from "@rova/shared/types/json";
/**
 * `isEffectSchema` is the narrowing an integration's own suite needs: a step's
 * `input` and `output` are typed as any Standard Schema, so running one through
 * `Schema.toCodecJson` to assert a wire shape asks first.
 */
export { isEffectSchema, readAs } from "@rova/shared/types/schema";
export { isoTimestampString } from "@rova/shared/types/timestamp";
export { getErrorMessage } from "@rova/shared/utils";
export { requireOutputFieldsFromSchema } from "@rova/shared/graph/output-fields";
/**
 * The HTTP call an integration makes to the system behind it, with the timeout,
 * the retry schedule and the repeat-safety rule that decide when a request may
 * be sent twice. An integration written outside this repo gets that rule here
 * rather than writing its own, and getting it wrong sends a second message to a
 * real person.
 *
 * `callExternal` answers an Effect and runs inside a `defineStep` handler, which
 * is already given the transport. `callExternalAsync` provides the transport
 * itself, for a connection test or a handler written as a plain async function.
 */
export {
  callExternal,
  callExternalAsync,
  type ExternalBody,
  type ExternalCallResult,
  type ExternalError,
  ExternalRejected,
  type ExternalRequest,
  ExternalUnreachable,
  ExternalUnreadable,
  parsePayload,
} from "#src/backend/extensions/steps/external-http";
/**
 * The transport layer a `defineStep` handler already runs with, for the callers
 * that run a client's effect themselves: an integration's own test suite, which
 * exercises a client directly rather than through a step. One definition rather
 * than a copy per package, because the `Context.Reference` caching it works
 * around is the kind of thing that gets fixed in one copy and not the other.
 */
export { ExternalTransport } from "#src/backend/extensions/steps/external-transport";
