# Writing an integration

How to author an integration against `@wfgraph/core/plugin`: `defineIntegration`, replay safety, Effect vs Promise, config forms, testing, step-boundary schemas, and OAuth adapters.

For the six built-ins in this repository, also see `packages/plugins/src/AGENTS.md`.

The server half builds against `@wfgraph/core/plugin` alone, so an outside package is written
the same way. That surface exports `defineIntegration`, `CredentialFields`, `CredentialsOf`,
`checkIntegration`, `StepFailure`, `StepBag`, `IntegrationTestResult`,
`IntegrationTestContext`, `callExternal`,
`callExternalAsync`, the OAuth contract types, and `ExternalTransport`.
`@wfgraph/core/testing` is a second entry, and
holds `runAction`, `actionData` and `actionError` for the integration's own suite.

The browser half is the one gap. `@wfgraph/plugins/ui` exports the built-in icons and output
renderers as one record, keyed by integration type. The editor imports that record by name
and provides it through React context, so today that record is reachable from inside this
repository alone.

An integration is one `defineIntegration` value. It holds the credential form, an action
per record key, the Events it owns, an optional webhook that produces them, and a loader
for the connection test.

```ts
import {
  type CredentialFields,
  type CredentialsOf,
  defineIntegration,
  StepFailure,
} from "@wfgraph/core/plugin";
import { Effect, Schema } from "effect";
// Your own client over `callExternal`. It answers an Effect the handler yields.
import { createThing } from "#src/my-service/client";

// The key names the credential: it is where the stored config holds the value
// and what a handler reads it under. The dialog asks in the order written here.
// `satisfies` rather than an annotation, which would widen `type` to `string`.
const myServiceCredentials = {
  MY_SERVICE_API_KEY: { label: "API Key", type: "password" },
} satisfies CredentialFields;

/** The keys a handler can read. A misspelled one fails to compile. */
export type MyServiceCredentials = CredentialsOf<typeof myServiceCredentials>;

export const myService = defineIntegration({
  type: "my-service", // prefixes each action id
  label: "My Service",
  description: "What this integration does",
  credentials: myServiceCredentials,
  // The test reaches the system, so it stays behind a dynamic import until
  // someone presses "Test connection".
  test: async () => (await import("#src/my-service/test")).testMyService,
  // The record key is the action slug, and its only home. Assembly computes the
  // action id "my-service/do-something".
  actions: {
    "do-something": {
      label: "Do Something",
      description: "What this action does",
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({
        id: Schema.String.annotate({ description: "Item ID" }),
      }),
      // Optional. `input` draws the form, so this states what a schema cannot.
      // Workflow Graph checks each `key` against the schema.
      configFields: [{ key: "text", placeholder: "Something to send" }],
      // One bag, the way an Inngest handler takes one. Destructure what you use.
      handler: Effect.fn(function* (bag) {
        // Credentials arrive as an effect, so a step reads them only when it
        // has work to do. Two yields fetch once.
        const credentials = yield* bag.credentials;
        const apiKey = credentials.MY_SERVICE_API_KEY;

        if (!apiKey) {
          return yield* Effect.fail(
            new StepFailure({
              message: "MY_SERVICE_API_KEY is not configured.",
            })
          );
        }

        return { id: yield* createThing(apiKey, bag.input.text) };
      }),
    },
  },
});
```

## The definition

**`defineIntegration` owns everything around the handler:** the config decode, the
credential fetch, the run log rows, and the `StepResult` envelope the engine reads. A
handler answers its output alone.

**An action is an object literal, and it stays inline.** That is what types its handler:
`bag.input` comes from that action's own `input` schema and `bag.credentials` from the
integration's own `credentials` record, with no annotation written anywhere. Lifting an
action, or its handler, into a `const` above the call loses the contextual type that does
it, so both are written where they are read.

**`category` defaults to the integration's `label`.** An action wanting a different
heading in the selector still writes one.

**`sideEffect: true` marks an action that changes something outside the workflow**: a
message sent, a record written or removed. It defaults to `false`, which says the action
only reads. The editor keeps an action carrying it out of a Group, because a Group is a
bundle a builder pastes again after a Wait so the next send reads a fresh fetch, and a
change to the outside world would land again with every paste. Note that this is a
narrower question than the replay sense of the phrase the next section uses, where a
lookup's own HTTP call counts too because `step.run` has to memoize it. `defineAction`
takes the same field.

**`events` are `defineEvent` values this integration owns.** Assembly folds them into
the one catalog and stamps `EventMetadata.integration`, so the editor can offer a
Connection picker. Identity stays the Event name; a webhook is how they arrive.
Export `defineEvent` from `@wfgraph/core/plugin`. An integration-owned Start, Cancel,
or Wait Event must name a Connection at Publish.

**`webhook` is the ungated intake** that verifies a vendor POST and maps it onto
the webhook's `source` name for `inngest.send`. Catalog Events listen on that source
and narrow with `source.when`. `receive` returns `{ data, id? }`; the route sends
`source`. `verify` sees the raw body (`c.req.text()`), because HMAC schemes are
sensitive to a single byte of re-serialization. `receive` sees the parsed JSON. An
ignored payload is `undefined` (200, no send). `SignatureRejected` is 401. The
Connection id is stamped on Inngest event `data` as `__wfgraphConnectionId` (v4
does not persist `event.user`) and stripped before decode, so the payload the
graph sees is the vendor envelope, including any `connectionId` the vendor sends
of its own. Assembly refuses an integration Event declaring a payload field at
the reserved key. Matching is the stored Connection on Lifecycle Rules and
Wait Subscriptions, not a CEL field.
`helpText` is shown under the copyable URL on the Lifecycle Node, Wait node, and
Connection dialog. `secret` names the Connection credential `verify` reads; the
editor uses it to tell a filled secret from a send-only Connection.

**A handler takes one bag**, holding `input` (the decoded config), the credential reads,
`step`, and the run's identity: `runMode`, `executionId`, `nodeId`, `nodeName`,
`integrationId`. `defineAction` calls its handler the same way. One object rather than two
parameters is Inngest's shape, and it takes a later value with no new position for an author
to learn.

## What is remembered across a replay

A durable runtime re-runs the whole workflow function every time a run resumes, after a
sleep, after a wait, after a retry. **Workflow Graph wraps no handler body.** Work with a side effect
goes inside `step.run` or it happens again on every attempt:

```ts
const posted = yield* bag.step.run("post", callSlack(apiKey, ...));
```

You name the work; Workflow Graph prefixes the node it belongs to, so two nodes running the same
action never read one another's stored result. Wrap the call out to the system and leave
parsing, branching and shaping outside it: those are cheap to repeat, and keeping them out
keeps the stored value small.

Three rules:

- **What `step.run` answers must be JSON.** A `Date`, `Map`, `Set`, `Error` or class
  instance inside it changes shape when the run resumes. The compiler refuses one and names
  the field, so carry a timestamp as an ISO string and let the output schema decode it back.
  A class holding only data reads as a plain object and gets through: its fields survive the
  resume and its prototype does not, so `instanceof` is false on the far side.
- **A `StepFailure` fails the node once.** It travels back as a value rather than a throw,
  so a system that refused a request does not spend the retry budget on an answer that will
  not change. Anything else that throws inside is a step the runtime retries.
- **A handler that wraps nothing still opens one memoized log row.** The run panel then
  shows one row for however many times the work ran, so the log is not evidence it ran once.

`docs/adr/0009` is why this is the author's job rather than Workflow Graph's.

## Effect for integrations, Promise for host actions

**Integrations author with Effect.** The six built-ins and anything built against
`@wfgraph/core/plugin` use `Effect.fn`, because `callExternal` answers an Effect and a handler
yields it directly. Fail with a `StepFailure`. Durable work is
`yield* bag.step.run(id, effect)`. Credentials are `yield* bag.credentials`. Do not reach for
`readCredentials`, `callExternalAsync`, or a Promise factory for `step.run` in an integration
handler — those are the host bridge.

**A connection test is told where each credential came from.** Its second argument is an
`IntegrationTestContext`, whose `oauthCredentialKeys` names the credentials a stored OAuth
grant issued; it is empty for the form an operator is still filling in. A grant asks for the
narrow scopes its actions need, so a provider's permission refusal on a wider read can be
what proves the credential valid. `packages/plugins/src/resend/test.ts` is the worked case.

**Host `defineAction` stays Promise-first.** An adopter needs no Effect. An `async` handler
fails by a throw, and the message becomes the sentence in the run log. Durable work is
`step.run(id, () => promise)`. A connection test is also a Promise seam and uses
`callExternalAsync`.

```ts
// Host defineAction — Promise-first, no Effect required.
handler: async ({ input, readCredentials, step }) => {
  const { MY_SERVICE_API_KEY } = await readCredentials();
  if (!MY_SERVICE_API_KEY) {
    throw new Error("MY_SERVICE_API_KEY is not configured.");
  }

  return step.run("create", () => createThing(MY_SERVICE_API_KEY, input.text));
},
```

| Integration (`@wfgraph/core/plugin`) | Host `defineAction`                     |
| ------------------------------------ | --------------------------------------- |
| `Effect.fn` handler                  | `async` / plain function                |
| `yield* bag.credentials`             | `await bag.readCredentials()`           |
| `callExternal`                       | `callExternalAsync`                     |
| `yield* bag.step.run(id, effect)`    | `await bag.step.run(id, () => promise)` |
| Fails with `StepFailure`             | Fails by a throw                        |

Internally both arms of `step.run` share one Effect memoization path; the Promise overload is
a thin adapter. The rest of the contract (config decode, output encode, run log) is identical.
One case is worth knowing: `readCredentials` rejects with the failure a refused credential
store raises, and Workflow Graph fails the node on it, naming the store in the message. A handler that
catches around the await turns that into whatever it answers next, so catch narrowly.

## The config form

`input` draws it. Each key the schema declares becomes a field, labelled from its
`description` and required where the schema requires it.

`configFields` states what a schema cannot: a placeholder, a `template-textarea` row count,
a friendly `select` label, a `showWhen`, a group. An entry merges into the derived field of
the same key, property by property. `configFields` is optional, and a schema that already
says everything stands on its own.

Order follows your entries, and Workflow Graph draws each key you left out after them, in schema
order. A group takes its position from your list, because its placement is a decision you
make.

A `key-value` field stores its rows as one JSON string, and each row's value carries
`{{@nodeId:Label.path}}` references. The engine resolves them one row at a time and
re-serialises, so a resolved value holding a quotation mark reaches your handler escaped
rather than leaving the string unparseable. A row's name is left as authored, because it is
the key of whatever you build from it.

### Fields the connection fills in

A field whose choices live in the operator's own account names a provider instead of a
static `options` list. `provider-select` draws a dropdown over what that provider lists;
`provider-fields` draws one input per value it declares, stored as one JSON object under the
one config key, so the handler still reads one string and parses it.

```ts
configOptions: {
  templates: {
    answers: "options",
    load: async () => (await import("./config-options")).templateOptions,
  },
},
// ...on the action:
configFields: [
  {
    key: "templateId",
    label: "Template",
    type: "provider-select",
    optionsSource: { provider: "templates" },
  },
],
```

A provider is a function of the connection's credentials and the sibling config values its
`optionsSource.parameters` named. It answers options, fields, or `unavailable` with a
sentence saying what is wrong, because a provider refusing is something the builder acts on
rather than a failed request. Return `unavailable` for a refusal and let anything else
throw: the credentials never leave the server, and neither does the text of an exception,
which can carry a request URL holding a key.

Every one of these falls back to the template control it replaces. A builder with no
connection chosen, a grant too narrow to read what the field needs, or a value that is
already a `{{...}}` reference still types the value themselves. `checkIntegration` refuses a
field naming a provider that does not exist or answers the wrong kind, so the wiring fails in
your own suite rather than in someone's panel.

## Testing an integration

`@wfgraph/core/testing` runs one action the way a workflow runs it, through the config decode,
the credential fetch, the handler and the output encode:

```ts
import { actionData, actionError, runAction } from "@wfgraph/core/testing";

it.effect("sends the message", () =>
  Effect.gen(function* () {
    const answer = actionData(
      yield* runAction(myService, "do-something", {
        input: { text: "hello" }, // the resolved config, as a builder typed it
        credentials: { MY_SERVICE_API_KEY: "key_1" },
      })
    );

    expect(answer).toEqual({ id: "item_1" });
  })
);
```

The slug is held to the actions the integration declared, so a renamed action fails to
compile rather than leaving a case that covers nothing. `actionData` throws for a step that
gave up and `actionError` throws for one that did not, so neither hides the other's
outcome. `input` is the encoded side: a schema that transforms decodes it on the way in, so
a case supplies the text a builder would have typed.

`credentials` takes an `Effect` as well as a record, which is what a case pins the lazy
read with: a handler that decides it has nothing to send never runs it.

## Schemas at a step boundary

Write them in the library you already use. Effect Schema, Zod, arktype, anything that
publishes Standard Schema. What differs is how much Workflow Graph does with them.

**An Effect schema crosses its canonical JSON codec in both directions.** A step boundary is
JSON on both sides, so Workflow Graph runs `Schema.toCodecJson(schema)`, built once at definition.
`defineAction` reads and answers through the same codec, so an action of a host written in
Effect Schema gets this too. An input schema can therefore carry a transform:

```ts
// One text field decodes to a list on the way in.
input: Schema.Struct({
  urls: Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform<readonly string[], string>({
        decode: (text) => text.split(",").map((entry) => entry.trim()),
        encode: (entries) => entries.join(","),
      })
    )
  ),
}),
// A `Date` encodes back to an ISO string on the way out.
output: Schema.Struct({
  sentAt: Schema.String.pipe(
    Schema.decodeTo(Schema.Date, SchemaTransformation.dateFromString)
  ),
}),
```

A handler that answers with something its output schema cannot encode fails the node once,
naming the field path, and keeps its retries for a failure that might clear.

**A schema from another library** publishes a validator and a JSON Schema. Workflow Graph
runs `~standard.validate` on the way in (config) and on the way out (the handler's
answer), and derives the form and field list as usual. The value that validate returns is
what the node keeps, so a library that strips undeclared keys (Zod's default object)
trims here too, and one that keeps them (`z.looseObject`) keeps them because the
author said so. Answer with JSON either way: the engine memoizes a step result and
replays it.

**That encode (or validate) is a trim when the schema says so.** An Effect encode keeps
the keys the schema declares, so a step that hands back a whole object from a system must
describe each field it means to pass on. `Schema.StructWithRest` over a `Schema.Record`
rest is the other spelling, for a shape that is genuinely open. A foreign library follows
its own object policy for the same question (`z.looseObject` in Zod, for example).

**An open record is addressable by key.** A `Schema.Record` names no properties, so the
editor lists the record itself and asks for the key beside it: choosing `tags` on a
condition draws a Key box, and the run reads `tags.order_id` off the payload. Resend's email
tags are the case this is for. Declare the value type, because that is what a condition
compares against; a record of strings makes `tags.order_id` a text rule. A rule whose key is
still unnamed is refused rather than compared against the whole record.

Where a `key-value` config field is what fills the record, name the record paths on it with
`fillsRecords` and the editor offers the keys instead of asking for them. Resend's Tags field
declares `["tags", "data.tags"]`: the first is the Send Email step's own output, the second is
what every outbound `resend/email.*` Event carries, so tagging a send with `order_id` makes
`data.tags.order_id` a path a Wait match can be built on. Paths are matched inside one
integration. Treat it as a suggestion: a key nothing in the workflow names still resolves when
it is typed.

**Each side takes its own optional spelling.** The codec rewrites `optional(X)` to
`optionalKey(NullOr(X))`.

```ts
// Input: a field a builder left blank arrives with its key absent, so `NullOr`
// is unnecessary here.
Schema.optionalKey(Schema.String);
// Output from the payload of a system: this one spelling survives a key the
// system omitted and a null it sent.
Schema.optionalKey(Schema.NullOr(Schema.String));
```

Either spelling reaches the editor as a nullable field. The condition picker badges
such a path and offers `is set` and `is not set` on it, which is how a rule asks
whether the value arrived at all, so leave a key optional only where the system
really can omit it.

## Three rules

**A handler sits inline, and that is the only spelling.** An integration is the one file,
however many actions it declares, and its SDK, where it has one, is a plain import of that
file.

**`checkIntegration` is the assembly check for one integration, exported for your own suite.**
Assembly calls it for each integration a host passes, so a bad definition fails the
application that turned it on: actions, credentials, provider-backed fields, Events, and
the webhook that produces them. Cross-integration uniqueness (two plugins declaring the
same Event name) stays in `assembleExtensions`. Call `checkIntegration` in the tests of
the defining package and the failure lands where the author reads it.

**Describe the wire.** The types of an SDK are its own promise about the JSON of somebody
else, and a typed client casts a response rather than validating it. Model what a recorded
response holds. Keep the fields a handler depends on required, and make the rest tolerant.
Twilio is the worked example: `twilioMessageSchema` in
`packages/plugins/src/twilio/client.ts` requires the three fields its handler reads and
leaves the rest optional and nullish.

For the file layout of the six built-ins, the external HTTP layer, config field types,
and the test pattern, see `packages/plugins/src/AGENTS.md`.

## OAuth

Add `oauth` when the external system can issue a grant. The integration owns the
provider protocol. Core owns the browser flow, encrypted grant storage, and refresh
coordination. Configure `publicUrl` on `createWfGraphApp`; Core derives stable callback
and client metadata URLs from that origin. Host routes, `auth` cookie rules, and
turning on Slack, Resend, or PostHog OAuth are in `docs/embedding.md` ("Built-in integrations").

The OAuth value below is assigned to an integration's `oauth` property. The two
complete forms are compile-checked in
`packages/plugins/src/integration-oauth-contract.test.ts`.

### Registered confidential client, without PKCE

Close over the host-supplied registration. Its secret never enters the catalog or
client metadata. Token writes use `callExternalAsync(callExternal(...))`; this
example keeps the provider-specific response decode in a typed client helper.

```ts
import type {
  IntegrationOAuth,
  OAuthGrant,
  OAuthRefreshInput,
  OAuthRevokeInput,
  OAuthTokenSet,
} from "@wfgraph/core/plugin";

type ConfidentialProvider = {
  readonly exchange: (input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly redirectUri: string;
  }) => Promise<OAuthGrant>;
  readonly refresh: (input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly grant: OAuthGrant;
  }) => Promise<OAuthTokenSet>;
  readonly revoke: (input: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly grant: OAuthGrant;
  }) => Promise<void>;
};

export function registeredClientOAuth(
  registration: { readonly clientId: string; readonly clientSecret: string },
  provider: ConfidentialProvider
): IntegrationOAuth {
  return {
    label: "My Service",
    registerClient: () => registration,
    authorize: ({ client, redirectUri, state }) => {
      const url = new URL("https://auth.example.com/authorize");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      return url;
    },
    async exchange({ client, code, redirectUri }) {
      const clientSecret = client.clientSecret;
      if (!clientSecret) {
        throw new Error("My Service OAuth client secret is not configured.");
      }

      return provider.exchange({
        clientId: client.clientId,
        clientSecret,
        code,
        redirectUri,
      });
    },
    async refresh({ client, grant }: OAuthRefreshInput) {
      const clientSecret = client.clientSecret;
      if (!clientSecret) {
        throw new Error("My Service OAuth client secret is not configured.");
      }

      return provider.refresh({
        clientId: client.clientId,
        clientSecret,
        grant,
      });
    },
    async revoke({ client, grant }: OAuthRevokeInput) {
      const clientSecret = client.clientSecret;
      if (!clientSecret) {
        throw new Error("My Service OAuth client secret is not configured.");
      }

      await provider.revoke({ clientId: client.clientId, clientSecret, grant });
    },
  } satisfies IntegrationOAuth;
}
```

### Public metadata client, with S256 PKCE

Use Core's metadata URL as the client ID. `pkce: "S256"` narrows both methods:
`authorize` receives a challenge and `exchange` receives the matching verifier.

```ts
import type {
  IntegrationOAuth,
  OAuthGrant,
  OAuthRefreshInput,
  OAuthRevokeInput,
  OAuthTokenSet,
} from "@wfgraph/core/plugin";

type PublicProvider = {
  readonly exchange: (input: {
    readonly clientId: string;
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
  }) => Promise<OAuthGrant>;
  readonly refresh: (input: {
    readonly clientId: string;
    readonly grant: OAuthGrant;
  }) => Promise<OAuthTokenSet>;
  readonly revoke: (input: {
    readonly clientId: string;
    readonly grant: OAuthGrant;
  }) => Promise<void>;
};

export function publicClientOAuth(provider: PublicProvider): IntegrationOAuth {
  return {
    label: "My Service",
    pkce: "S256",
    registerClient: (context) => ({
      clientId: context.metadataDocumentUrl,
      metadataDocument: {
        client_id: context.metadataDocumentUrl,
        client_name: "Workflow Graph",
        client_uri: context.publicUrl,
        redirect_uris: [context.callbackUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "things:write",
      },
    }),
    authorize: ({ client, redirectUri, state, codeChallenge }) => {
      const url = new URL("https://auth.example.com/authorize");
      url.searchParams.set("client_id", client.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "things:write");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url;
    },
    async exchange({ client, code, redirectUri, codeVerifier }) {
      return provider.exchange({
        clientId: client.clientId,
        code,
        redirectUri,
        codeVerifier,
      });
    },
    async refresh({ client, grant }: OAuthRefreshInput) {
      return provider.refresh({ clientId: client.clientId, grant });
    },
    async revoke({ client, grant }: OAuthRevokeInput) {
      await provider.revoke({ clientId: client.clientId, grant });
    },
  } satisfies IntegrationOAuth;
}
```

### Client registration and public metadata

`registerClient` supports two client identity models:

- A registered-client integration returns a provider-issued client ID and optional
  client secret. The integration can close over host configuration to supply them.
- A client metadata integration uses `context.metadataDocumentUrl` as its client ID
  and returns a `metadataDocument`. Workflow Graph serves that document from a public
  route because the provider, not an operator's browser session, reads it.

Public client metadata has a strict allowlist of fields: client identity and name,
client URI, redirect URIs, grant and response types, token endpoint authentication
method, and scope. Unknown fields fail validation. Provider secrets, token values,
and executable provider behavior cannot enter this document. The extension catalog
carries only `oauth.label`; it doesn't expose registration details.
The document's `redirect_uris` value must contain only `context.callbackUrl`.

Register every scope the integration could ever need, because the registered set is
the ceiling on what an operator is allowed to grant. A provider whose consent page
offers its own permission chooser grays out anything outside that set, so a document
naming one scope makes the wider one ungrantable however the authorization is built.

### What the provider granted

Where the provider owns the permission decision, leave it there: its consent page is
the one place an operator picks, and an authorization that names no scope asks for the
client's whole registered set. Do not add a control to the connection dialog that
appears to change access. Access changes only by authorizing again.

Report what came back instead. An adapter returns `grantedAccessLabel` on its token
set, worded as the provider words it, read off the token response rather than assumed
from the request. Both `exchange` and `refresh` return it, so a provider that narrows a
grant is recorded rather than left claiming the old access, and the connection dialog
shows it read-only beside the account. The dialog's Reconnect runs a fresh
authorization, which is the only thing that can change a grant wherever a refresh
cannot widen one.

### Core owns the browser flow

Do not reimplement attempts, cookies, callback claiming, or refresh locking. Those
are Core's. `docs/embedding.md` ("Built-in integrations") lists the four OAuth routes
and the `publicUrl` / `auth` requirements a host must satisfy.

For an integration with `pkce: "S256"`, Core generates the verifier and passes its
SHA-256 challenge to `authorize`. The type of `authorize` requires `codeChallenge`,
and the type of `exchange` requires `codeVerifier`. An integration without `pkce`
receives neither value.

After exchange, return an `OAuthGrant`. Core validates that `credentials` contains
only keys declared by the integration, and then stores the normalized grant in the
connection's encrypted configuration. Browser responses omit the stored grant. OAuth
credential values override matching manual values, so an existing action handler reads
the same credential name in either connection mode.

`exchange` returns an `OAuthGrant`. `refresh` returns an `OAuthTokenSet`. Include an
ISO 8601 `expiresAt` value when the provider gives an access-token lifetime. Core starts
a refresh before expiry and persists the access token, refresh token, expiry, and
credential mapping as one replacement. Core serializes refreshes for one connection;
an adapter must not retry a token write independently.

Token exchange, refresh, and revocation requests are writes. Pass them to
`callExternalAsync` as `POST` requests with no idempotency key and do not set
`safeToRepeat`. Disconnect calls `revoke` before Core removes the stored grant. If
revocation fails, Core preserves the grant so the operator can retry.

Provider errors become connection failures without exposing authorization codes,
client secrets, access tokens, or refresh tokens. Never include those values in
messages or logs.

### Test OAuth behavior

Test the provider adapter separately from Core's generic OAuth lifecycle. Pin the
following provider behavior in `[name]/oauth.test.ts`:

- The client registration result and, for a metadata client, the complete public
  metadata document.
- The complete authorization URL, including state, redirect URI, scopes, and PKCE
  parameters.
- The exact exchange, refresh, and revocation requests, including form fields and
  authentication headers.
- Successful token normalization, rotating refresh-token replacement, rejected and
  unreadable responses, and missing required token fields.
- Error messages that don't contain any submitted client secret, authorization code,
  access token, refresh token, or encoded equivalent.

Use recorded provider responses as decoding fixtures. Core's service and persistence
tests cover one-use attempts, browser binding, encrypted payloads, credential-key
validation, refresh fencing, callback conflicts, and disconnect ordering.

## Evolving an action

Keep the same action id when an in-progress run should resume without failing decode
and completed steps should keep their memoized results. Published workflows pin a
catalog fingerprint that hashes action ids and config/output **keys**, not handler
bodies or field types; Inngest replays completed `step.run` calls from stored JSON.

**Safe under one id:**

- **Add** config keys with `Schema.optionalKey` only. Never rename or remove a key:
  removal changes the fingerprint and fails waking nodes on pinned versions.
- **Add** output paths only. Never remove or rename a path downstream nodes may
  reference.
- **Tighten** validation only when every value a published graph could hold still
  passes. Stricter rules on the same keys do not change the fingerprint — the main
  footgun.
- **Change** handler logic inside an existing `step.run` id for work not yet memoized.
  Completed steps keep their cached answer.
- **Rename** a `step.run` id (for example `"post"` to `"post-v2"`) when a side effect
  must run again for in-flight executions.
- **Normalize** legacy config shapes with a decode transform on the input schema
  (see the comma-separated list example above).

## Retiring an action

When the contract cannot stay compatible under the same id, ship a new action
(for example `my-service/send-v2`) and set **`hidden: true`** on the old one. Hidden
actions stay registered for runs and in the catalog fingerprint; the editor's action
picker omits them, so new steps cannot select them. Workflows that already reference
the old id keep configuring and running it until you delete the action from code,
which you should do only when no published version and no in-flight execution still
references it.
