/**
 * What a package of integrations may use from WfGraph's server.
 *
 * `@wfgraph/plugins` builds against this and nothing else, so an outside
 * integration package can be written the same way. Anything added here is a
 * promise; add it only when a plugin cannot be written without it.
 *
 * What is below is the whole of it, for a file that runs on the server. An
 * integration is one `defineIntegration` call: a credential record, and an
 * action per record key holding an input schema, an output schema, the metadata
 * the editor draws it with, and a handler. There is nothing to register: an
 * integration is a value a host passes to `createWfGraphApp`, and the credential
 * fetch and the run logging are `defineIntegration`'s business.
 *
 * **Effect is the integration authoring path.** Handlers are `Effect.fn`,
 * credentials are `yield* bag.credentials`, HTTP goes through `callExternal`,
 * and durable work is `yield* bag.step.run(id, effect)`. Schemas may still come
 * from any Standard Schema library. A host's own `defineAction` stays
 * Promise-first (`async` handlers, `readCredentials`, Promise `step.run`); that
 * bridge is not what an integration writes.
 *
 * A connection test answers the credentials UI over a Promise, so it calls out
 * through `callExternalAsync`. That is the one Promise HTTP seam on this entry.
 *
 * An integration's own suite drives an action through `@wfgraph/core/testing`,
 * which is a separate entry because nothing in it runs in a server.
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
export type { CredentialFields } from "@wfgraph/shared/extensions/catalog";
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
 * The `@wfgraph/shared` vocabulary a server-side plugin file needs beside the
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
} from "@wfgraph/shared/types/json";
/**
 * `isEffectSchema` is the narrowing an integration's own suite needs: a step's
 * `input` and `output` are typed as any Standard Schema, so running one through
 * `Schema.toCodecJson` to assert a wire shape asks first.
 */
export { isEffectSchema, readAs } from "@wfgraph/shared/types/schema";
export { isoTimestampString } from "@wfgraph/shared/types/timestamp";
export { getErrorMessage } from "@wfgraph/shared/utils";
export { requireOutputFieldsFromSchema } from "@wfgraph/shared/graph/output-fields";
/**
 * The HTTP call an integration makes to the system behind it, with the timeout,
 * the retry schedule and the repeat-safety rule that decide when a request may
 * be sent twice. An integration written outside this repo gets that rule here
 * rather than writing its own, and getting it wrong sends a second message to a
 * real person.
 *
 * `callExternal` answers an Effect and runs inside a `defineStep` handler, which
 * is already given the transport. `callExternalAsync` provides the transport
 * itself for a connection test (the credentials UI's Promise seam). A host
 * `defineAction` written as async may use it too; an integration handler does
 * not — it yields `callExternal`.
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
