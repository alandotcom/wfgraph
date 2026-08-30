# Writing an integration

`docs/integrations.md` is the walkthrough: the `defineIntegration` shape, what it owns
around a handler, the canonical JSON codec and which optional spelling goes on which side.
This file holds what is specific to the six integrations in this directory.

## The files

The minimum, which `slack/` and `twilio/` are:

```
plugins/[name]/
  index.ts           the integration: credentials, schemas, actions, metadata
  index.test.ts      what the definition contributes: slugs, credentials, fields
  [subject].test.ts  the handlers, each run with a context the case supplies
  client.ts          the system's HTTP API, over fetch
  config-options.ts  what a provider-backed config field asks the connection
  client.test.ts     what the client puts on the wire
  test.ts            the connection test the credentials UI runs
  icon.tsx           the SVG icon component
```

A larger integration adds modules beside those rather than growing `index.ts` without
limit: `clerk/` has `types.ts` for the system's wire shapes, `metadata.ts` for the config
parser two of its actions share, and a `components/` directory for its output renderer;
`linear/` has an `errors.ts`; `resend/` has `events.ts` and `webhook.ts` for the Events a
Svix POST raises. What stays in `index.ts` either way is the integration itself, so a
reader opens one file to learn what it does. `clerk/` is the largest at four
actions, with its schemas above the `defineIntegration` call and each action written
inline in the `actions` record.

**An action is an object literal and its handler is written inside it.** That is what types
them: `bag.input` comes from that action's own `input` schema and `bag.credentials` from
the integration's `credentials` record, with no annotation written anywhere. Lifting either
into a `const` above the call loses the contextual type that does it, so a definition that
compiles is one written in place. `category` defaults to the integration's `label`.

## Calling the external system

**Call out through `callExternal`, not through an SDK.** It takes a request spec and
answers an `Effect` holding the decoded body over Effect's own `HttpClient`. It owns the
ten-second per-attempt timeout, the retry schedule, the JSON read, the decode, and the
three failures a call can end in: `ExternalUnreachable`, `ExternalRejected` (carrying the
system's own error body), and `ExternalUnreadable`.

It lives in core, at `packages/core/src/backend/extensions/steps/external-http.ts`, and
reaches this package through `@wfgraph/core/plugin`. That is deliberate: the repeat-safety
rule it holds is the one an integration written outside this repo would otherwise invent,
and inventing it wrong sends a second message to a real person.

`ExternalTransport` beside it provides `FetchHttpClient.Fetch` explicitly, with a function
reading `globalThis.fetch` per call, for the `Context.Reference` caching reason root
AGENTS.md's "Pitfalls that have bitten" section covers. A step handler is given it.
`callExternalAsync` provides it. A `client.test.ts` exercising a client outside a step
provides it by name.

A `client.ts` is the adapter above that: the auth header, the endpoints, the system's
error-envelope schema, and a `describeXFailure` saying what a failure means in words. Its
calls answer an `Effect` a step yields directly. Twilio's client is the one to copy. The
retry policy is stated once, above `RETRY_ATTEMPTS`, and Inngest's function-level retry is
the outer policy beyond it.

An SDK earns its place only where it carries protocol logic worth borrowing, which is why
`@clerk/backend` (JWT verification), `@linear/sdk` (a typed GraphQL client) and `svix`
(Resend webhook signatures) stayed while `twilio`, `resend`, `@slack/web-api` and
`posthog-node` did not. Those keep their own transport and error handling and do not go
through `callExternal`.

## OAuth adapters

`docs/integrations.md` owns the public OAuth contract and lifecycle. The following rules
are specific to maintaining the built-in adapters in this package.

Put a provider's OAuth protocol in `[name]/oauth.ts` when it is more than a few lines.
Export one `IntegrationOAuth` value and attach it to the integration in `index.ts`. Keep
an integration as a static value unless host-provided client credentials require a
factory. Slack is the example of that exception; Resend and PostHog are the
metadata-client pattern.

Keep provider behavior out of core. The adapter owns client registration, authorization
parameters, token and error response schemas, exchange, refresh, revocation, and the
mapping from an access token to declared credential keys. CIMD form POSTs live in
`oauth-cimd.ts`.

Register every scope the integration could ever need. The registered set is the ceiling
on what an operator may grant, so a document naming one scope makes the wider one
ungrantable no matter what the authorization asks for. Where the provider's consent page
picks the permission, ask for no scope and let it: Resend is that case, and its page
carries a Permission chooser. Report the result as `grantedAccessLabel` in the provider's
own wording, read off the token response rather than assumed from the request, and
return it from both `exchange` and `refresh` so a narrowed grant is recorded.

Follow these rules for client registration:

- For a registered client, close over host-provided credentials. Do not add the client
  secret to the integration catalog or public metadata.
- For a metadata client, use `context.metadataDocumentUrl` as both `clientId` and the
  document's `client_id`. Set `redirect_uris` to `[context.callbackUrl]`, and return
  only fields accepted by `PublicOAuthClientMetadata`.
- For a provider that requires PKCE, set `pkce: "S256"`. Use the required
  `codeChallenge` and `codeVerifier` parameters directly; don't cast or assert that they
  exist.

Exchange, refresh, and revocation consume authorization material and can rotate or
invalidate it. Send these provider writes through `callExternalAsync(callExternal(...))`
as `POST` requests. Do not add an idempotency key or set `safeToRepeat`. Core owns the
single-writer refresh claim; an adapter must not retry a token write independently.

Decode every success and error response with Effect Schema. Reject incomplete rotation
responses before returning: when a provider rotates refresh tokens, return the new access
token, refresh token, expiry, and credential mapping together. Map credentials only to
keys in the integration's `credentials` record.

Treat every client credential, authorization code, access token, refresh token, request
body value, and encoded form as sensitive. Before an adapter includes provider wording in
an error, remove the submitted sensitive values and their URL-encoded forms. Prefer a
bounded provider error code over an arbitrary description. Never log a token request or
response body.

Each OAuth adapter has an `oauth.test.ts`. Assert the complete authorization URL and exact
request method, URL, headers, and form body for exchange, refresh, and revocation. Cover
valid recorded responses, provider rejections, unreadable responses, missing required
fields, token rotation, and secret redaction. A metadata-client test also asserts the full
registration document. These tests own provider wire behavior; core tests own attempts,
browser binding, encrypted storage, refresh claims, and callback races.

## test.ts

The connection test the credentials UI runs, a Promise all the way out because that is how
the UI calls it. It is not an effect at its edge, so it is where `callExternalAsync` enters
the runtime and provides the transport. Validate a key's format before spending a request
where the system's keys have a known shape; it names the problem more precisely than a 401.

## icon.tsx and the ui record

`src/ui.ts` is the one module the browser imports from this package. It exports
`integrationUi`, a record keyed by integration type, and an integration takes one entry:

```ts
"my-service": { icon: MyServiceIcon },
```

The icon is an SVG component with an `aria-label` and a `<title>`; take the path from
simpleicons.org. `outputComponents` beside it maps an action slug to a React renderer for
that step's output in the runs panel.

## Config field types

The form is derived from the step's `input` schema, so a `configFields` entry states
only what the schema cannot and merges into the derived field of the same key. Write
none and the schema's own list is the form. `docs/integrations.md` ("The config form")
owns the rule.

| Type                | Description                                | Templates |
| ------------------- | ------------------------------------------ | --------- |
| `template-input`    | Single line, with `{{@nodeId:Label.path}}` | Yes       |
| `template-textarea` | Multi-line, same grammar                   | Yes       |
| `text`              | Plain text input                           | No        |
| `number`            | Numeric input                              | No        |
| `select`            | Dropdown over `options`                    | No        |
| `key-value`         | Dynamic key-value list                     | No        |
| `provider-select`   | Dropdown over what the connection lists    | Yes       |
| `provider-fields`   | One input per value the selection declares | Yes       |
| `group`             | Collapsible section holding `fields`       | N/A       |

The two provider-backed types take an `optionsSource` naming one entry of the integration's
`configOptions`, and `checkIntegration` refuses a field wired to a provider that answers the
wrong kind. Both fall back to the template control they replace, which is what a builder
gets when no connection is chosen, when the grant cannot read what the field needs, or when
the value is already a `{{...}}` reference. `resend/config-options.ts` is the worked example.

`showWhen: { field, equals }` hides a field until another holds a value. `defaultExpanded`
opens a group. A `select` may carry `defaultValue`. `literal: true` keeps a field out of
template resolution in every run mode, which is what a test destination declares, since a
run steering its own test address from its payload defeats the point of nominating one.

## Describe the wire, not the SDK

`docs/integrations.md` states the rule. Pin a wire shape with a fixture built from a
recorded response and an assertion running the decode: `twilio/client.test.ts` is the
pattern, and a field-derivation test alone catches none of what a vendor type gets wrong.

## Adding one

1. Write the files above under `packages/plugins/src/[name]/`.
2. Export the integration from `src/index.ts`, by name and in `builtInIntegrations`.
3. Add an entry to the `integrationUi` record in `src/ui.ts`.
4. `pnpm run type-check && pnpm run test && pnpm run fix`.
5. `pnpm run dev`, then add a connection, build a workflow on the action, and run it.

Naming: the folder is the integration `type` in kebab-case; the credential type is
`[Name]Credentials`; the connection test is `test[Name]`; the icon is
`[Name]Icon`; environment variables are `[NAME]_[FIELD]`.

## Testing

Drive the action, through `runAction` from `@wfgraph/core/testing`. A handler is written
inline and is not importable, and driving the action covers the whole path a run takes: the
config decode, the credential fetch, the handler, the output encode and the envelope.
`slack/send-slack-message.test.ts` is the pattern, with credentials as an `Effect.sync` that
counts its reads and the client as the stubbed seam.

```ts
const answer = actionData(
  yield *
    runAction(slack(), "send-message", { input, credentials, runMode: "test" })
);
```

The slug is held to the actions the integration declared. `input` is the encoded side, so a
case supplies the text a builder would have typed rather than what the schema decodes it to,
which twilio's comma-separated media list is the one example of. `actionData` throws for a
step that gave up and `actionError` throws for one that did not, so neither hides the
other's outcome. Passing `credentials` an `Effect` is what pins the lazy read.

`[name]/index.test.ts` beside it asserts what the definition contributes: the credential
vocabulary, the action slugs, and the field list `requireOutputFieldsFromSchema` derives from
each output schema. What Workflow Graph itself does around a handler is covered once, in
`packages/core/src/backend/extensions/steps/define-step.test.ts`.

`src/index.test.ts` runs `checkIntegration` over all six at module level, which is every
check `assembleExtensions` runs, so a bad definition fails that file's collection. A host
would otherwise meet it as a startup crash, and a description missing from one field of one
output schema would reach a reviewer as a green suite. `checkIntegration` is exported from
`@wfgraph/core/plugin` so an outside integration package can do the same.
