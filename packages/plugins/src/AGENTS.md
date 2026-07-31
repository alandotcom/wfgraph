# Writing an integration

README's "Writing an integration" is the walkthrough: the `defineIntegration` shape, what
`defineStep` owns, the canonical JSON codec and which optional spelling goes on which side.
This file holds what is specific to the six integrations in this directory.

## The files

The minimum, which `slack/` and `twilio/` are:

```
plugins/[name]/
  index.ts           the integration: credentials, schemas, actions, metadata
  index.test.ts      what the definition contributes: slugs, credentials, fields
  [subject].test.ts  the handlers, each run with a context the case supplies
  client.ts          the vendor's HTTP API, over fetch
  client.test.ts     what the client puts on the wire
  test.ts            the connection test the credentials UI runs
  icon.tsx           the SVG icon component
```

A larger integration adds modules beside those rather than growing `index.ts` without
limit: `acuity/` has `payloads.ts` for the vendor's wire shapes and `shared.ts` for the
config parsers its eight actions share, `clerk/` has `types.ts`, `metadata.ts` and a
`components/` directory for its output renderer, `linear/` an `errors.ts`. What stays in
`index.ts` either way is the integration itself, so a reader opens one file to learn what
it does. `acuity/` is the largest at eight actions and lays them out one after another,
schemas then handler then step, so the `actions` record at the foot reads as a contents
list.

## Calling a vendor

**Call vendors through `vendor-http.ts`, not their SDK.** `callVendor` takes a request spec
and answers an `Effect` holding the decoded body over Effect's own `HttpClient`. It owns the
ten-second per-attempt timeout, the retry schedule, the JSON read, the decode, and the three
failures a vendor call can end in: `VendorUnreachable`, `VendorRejected` (carrying the
vendor's own error body), and `VendorUnreadable`.

That module provides `FetchHttpClient.Fetch` explicitly, with a function reading
`globalThis.fetch` per call, for the `Context.Reference` caching reason root AGENTS.md's
"Pitfalls that have bitten" section covers.

A `client.ts` is the adapter above that: the auth header, the endpoints, the vendor's
error-envelope schema, and a `describeXFailure` saying what a failure means in words. Its
calls answer an `Effect` a step yields directly. Twilio's client is the one to copy. The
retry policy is stated once, above `RETRY_ATTEMPTS`, and Inngest's function-level retry is
the outer policy beyond it.

An SDK earns its place only where it carries protocol logic worth borrowing, which is why
`@clerk/backend` (JWT verification), `@linear/sdk` (a typed GraphQL client) and
`@fountain-bio/acuity` stayed while `twilio`, `resend` and `@slack/web-api` did not. Those
three keep their own transport and error handling and do not go through `vendor-http.ts`.

## test.ts

The connection test the credentials UI runs, a Promise all the way out because that is how
the UI calls it. It is the one caller that is not an effect, so it is where `runVendorCall`
enters the runtime and provides `VendorTransport`, the layer a `defineStep` handler already
runs with, exported from `@rova/core/plugin` rather than rebuilt per package. Validate a
key's format before spending a request where the vendor's keys have a known shape; it names
the problem more precisely than a 401.

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

| Type                | Description                                | Templates |
| ------------------- | ------------------------------------------ | --------- |
| `template-input`    | Single line, with `{{@nodeId:Label.path}}` | Yes       |
| `template-textarea` | Multi-line, same grammar                   | Yes       |
| `text`              | Plain text input                           | No        |
| `number`            | Numeric input                              | No        |
| `select`            | Dropdown over `options`                    | No        |
| `schema-builder`    | Structured output schema builder           | No        |
| `key-value`         | Dynamic key-value list                     | No        |
| `group`             | Collapsible section holding `fields`       | N/A       |

`showWhen: { field, equals }` hides a field until another holds a value. `defaultExpanded`
opens a group. A `select` may carry `defaultValue`. `literal: true` keeps a field out of
template resolution in every run mode, which is what a test destination declares, since a
run steering its own test address from its payload defeats the point of nominating one.

## Describe the wire, not the SDK

README states the rule. The worked example here is `acuity/`, whose SDK declares a
`calendarTimeZone` the API does not send and puts intake answers one level above where they
live, so every appointment action failed its encode on any appointment carrying a form. Pin
a vendor shape with a fixture built from a recorded response and an assertion running the
encode: `acuity/appointments.test.ts` is the pattern, and a field-derivation test alone would
have caught none of it.

## Adding one

1. Write the files above under `packages/plugins/src/[name]/`.
2. Export the integration from `src/index.ts`, by name and in `builtInIntegrations`.
3. Add an entry to the `integrationUi` record in `src/ui.ts`.
4. `pnpm run type-check && pnpm run test && pnpm run fix`.
5. `pnpm run dev`, then add a connection, build a workflow on the action, and run it.

Naming: the folder is the integration `type` in kebab-case; a handler is `[action]Handler`;
the credential type is `[Name]Credentials`; the connection test is `test[Name]`; the icon is
`[Name]Icon`; environment variables are `[NAME]_[FIELD]`.

## Testing

Test the handler, not the step: it is a function of `(input, context)` to an `Effect`, so a
case supplies the context it wants and runs it. `twilio/send-sms.test.ts` is the pattern,
with credentials as an `Effect.sync` that counts its reads and the vendor client as the
stubbed seam. That file also runs the assembled step through `implement`, which is the whole
path a run takes.

`[name]/index.test.ts` beside it asserts what the definition contributes: the credential
vocabulary, the action slugs, and the field list `requireOutputFieldsFromSchema` derives from
each output schema. What `defineStep` itself does around a handler is covered once, in
`packages/core/src/backend/extensions/steps/define-step.test.ts`.

`src/index.test.ts` runs `checkIntegration` over all six at module level, which is every
check `assembleExtensions` runs, so a bad definition fails that file's collection. A host
would otherwise meet it as a startup crash, and a description missing from one field of one
output schema would reach a reviewer as a green suite. `checkIntegration` is exported from
`@rova/core/plugin` so an outside integration package can do the same.
