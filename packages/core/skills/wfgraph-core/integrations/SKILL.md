---
name: integrations
description: >
  Write a Workflow Graph integration with defineIntegration, callExternal,
  IntegrationOAuth, runAction, and checkIntegration against @wfgraph/core/plugin.
  Load when building a vendor plugin, credential forms, OAuth adapters, or
  integration tests. Not for host defineAction.
metadata:
  type: sub-skill
  library: wfgraph
  library_version: "3.1.1"
sources:
  - alandotcom/wfgraph:docs/integrations.md
---

This skill builds on wfgraph-core. Host `defineAction` is
wfgraph-core/host-actions. Copy-paste the definition, HTTP client, OAuth
adapters, and `runAction` suite from `docs/integrations.md` (including the
two complete OAuth adapter forms under "OAuth").

# Writing an integration

An integration is one `defineIntegration` value. Nothing registers on import.
The host passes it in `extensions.integrations`. Build against
`@wfgraph/core/plugin` alone. Test with `@wfgraph/core/testing`.

## Authoring

- Action slug exists only as the `actions` record key; id is `${type}/${slug}`.
- Keep each handler an object literal inside `defineIntegration`. Lifting it
  into a `const` drops the typed `bag`.
- `test` is a loader so the vendor call stays behind a dynamic import until
  "Test connection".
- `input` draws fields. `configFields` adds what a schema cannot (placeholder,
  `showWhen`, `provider-select`). `configOptions` load choices from the
  connection; never leak exception text (it can hold a key in a URL).
- Effect Schema crosses the canonical JSON codec both ways. Optional input uses
  `Schema.optionalKey`; a vendor null uses
  `Schema.optionalKey(Schema.NullOr(...))`. Annotate output fields with
  `description`.
- `category` defaults to the integration `label`. `sideEffect: true` marks an
  external write; the editor keeps those out of a Group.
- `events` are `defineEvent` values. Assembly stamps `EventMetadata.integration`.
  Optional `webhook`: `verify` on the raw body, `receive` on parsed JSON.
  `SignatureRejected` is 401. Ignored payload is `undefined` (200, no send).
  Export `defineEvent` and webhook types from `@wfgraph/core/plugin`.

The browser UI record (`@wfgraph/plugins/ui`) is not a public host API for
outside packages today.

## HTTP and replay

Workflow Graph wraps no handler body. A durable runtime re-runs the whole
function after a sleep, wait, or retry. Work with a side effect goes in
`step.run` or it happens again.

- Integration handlers are Effect; connection `test` and OAuth token writes are
  Promise at the edge (`callExternalAsync`).
- `callExternal` answers an Effect (timeout, retry, JSON decode, three
  failures: `ExternalUnreachable`, `ExternalRejected`, `ExternalUnreadable`).
- An SDK earns its place only when it owns protocol (Clerk JWT, Linear
  GraphQL, Svix webhook signatures). Do not wrap Twilio/Slack/Resend-style HTTP
  SDKs.
- What `step.run` answers must be JSON. Carry timestamps as ISO strings.
- `StepFailure` travels as a value, so a refused call fails the node once
  rather than burning function-level retries.
- A handler that wraps nothing still opens one memoized log row.

## OAuth

The integration owns the provider protocol. Core owns the browser flow,
encrypted grant storage, and refresh coordination. Do not reimplement attempts,
cookies, callback claiming, or refresh locking.

Host `publicUrl`, callback `auth`, and Slack/Resend on/off: wfgraph-core and
wfgraph-plugins.

- Assign the adapter to `oauth` on `defineIntegration`.
- Close over host-supplied client id/secret. The secret never enters the
  catalog or public metadata.
- Public metadata client: `pkce: "S256"`. Core generates the verifier.
  `redirect_uris` is `[context.callbackUrl]` only. Unknown metadata fields fail
  validation.
- `exchange` returns `OAuthGrant`. `refresh` returns `OAuthTokenSet`. Return
  `grantedAccessLabel` from both, in the provider's words, read off the token
  response — not the requested scope.
- Token POSTs go through `callExternalAsync(callExternal(...))` with no
  idempotency key and do not set `safeToRepeat`. Core serializes refresh for
  one connection.
- Pin registration, the authorize URL, token HTTP, rotation, and secret-free
  error messages in `[name]/oauth.test.ts`. Core tests own attempts and fencing.

## Testing and evolving

- `runAction`, `actionData`, `actionError` from `@wfgraph/core/testing`. The
  slug is typed. `input` is the encoded side (what a builder typed).
- Call `checkIntegration` in the defining package's suite. Assembly runs the
  same check.
- Published workflows pin action ids and config/output **keys**, not handler
  bodies. Add config keys with `Schema.optionalKey` only. Add output paths
  only. Never rename or remove a live key.
- To break the contract: ship `type/slug-v2` and set `hidden: true` on the old
  action. Hidden stays registered for runs; the picker omits it. Delete only
  when no publication and no in-flight execution still references it.

## Common Mistakes

### CRITICAL Register on import

Wrong: `import "./my-service"` and hope that turned the integration on.

Correct: export the value and pass `extensions.integrations: [myService]`.

Source: alandotcom/wfgraph:docs/integrations.md

### CRITICAL HTTP call outside step.run

Wrong: `yield* sendMessage(apiKey, bag.input.text)` in the handler body.

Correct: `yield* bag.step.run("post", sendMessage(apiKey, bag.input.text))`.

Without `step.run`, a Wait later in the graph sends the message again on resume.

Source: alandotcom/wfgraph:docs/integrations.md (What is remembered across a replay)

### CRITICAL Retry refresh or set safeToRepeat on token POST

Wrong: `callExternal({ method: "POST", url: tokenUrl, safeToRepeat: true })`.

Correct: POST with no idempotency key; do not set `safeToRepeat`. Core holds
the refresh claim.

Source: alandotcom/wfgraph:docs/integrations.md (Core owns the browser flow)

### HIGH Lift the handler out of the actions record

Wrong: `const handler = Effect.fn(...)` above `defineIntegration`.

Correct: write the handler object literal inside `actions`.

Source: alandotcom/wfgraph:docs/integrations.md (The definition)

### HIGH Promise handler inside defineIntegration

Wrong: `handler: async ({ input, readCredentials }) => { ... }`.

Correct: `Effect.fn` and `yield* bag.credentials`. Promise is `defineAction`
and `test` / OAuth seams only.

Source: alandotcom/wfgraph:docs/integrations.md (Effect for integrations, Promise for host actions)

### HIGH Remove a config key on a live action id

Wrong: drop `channel` from `input` on the same id.

Correct: add keys with `optionalKey`; for a breaking contract, new id +
`hidden: true` on the old one.

Source: alandotcom/wfgraph:docs/integrations.md (Evolving an action)

### HIGH Pass decoded handler input to runAction

Wrong: `runAction(twilio, "send-sms", { input: { mediaUrls: ["https://a"] } })`
when the schema transforms from comma-separated text.

Correct: encoded side, what a builder typed.

Source: alandotcom/wfgraph:docs/integrations.md (Testing an integration)
