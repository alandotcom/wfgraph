# Adopt Effect v4 beta across the backend, with a Promise seam at the embedder surfaces

_Decided 2026-07-27 by Alan Cohen, following an architecture review._

The backend has grown a separate answer for each of error handling, validation, and
dependency wiring. Failures travel as a `ServiceResult` kind that every caller re-inspects,
validation runs through Zod at some boundaries and hand-written checks at others, and a
service reaches its database handle and its Inngest client through process globals. Effect
covers all of that ground with one typed model, so we
adopt `effect@beta` (the v4 line, `4.0.0-beta.102` at the time of the decision) across
`@rova/core`, `@rova/plugins`, and the server-side code in `@rova/shared`. The version is
pinned exactly, and every `@effect/*` package is held at a version-aligned release,
because a beta line moves under you otherwise.

We took the beta over `effect` 3.22 stable. The repo is pre-release: its data is
disposable, its consumers are all inside this tree, and AGENTS.md rules out compatibility
shims, so the usual reason to prefer a stable line (protecting what already ships on it)
carries no weight here. Choosing v3 would
buy a whole-backend v3-to-v4 migration a few months from now, and the Effect-TS skill
guidance at github.com/Effect-TS/skills that will steer day-to-day work here is written
against v4 idioms.

## Where Effect stops

Everything an embedder touches stays Promise-based: the `createRovaApp` options object,
the fetch handler it returns, `@rova/core/node`, and all of `@rova/client`. An embedder
should be able to mount Rova in an Express app without learning Effect.

`@rova/core/plugin` is the deliberate exception and becomes Effect-native. A step handler
returns an `Effect` with tagged errors, and a `defineStep` constructor owns credential
fetch, step logging, and construction of the result envelope. Plugins are where Effect
pays for itself, since most of a plugin's body is a vendor HTTP call with a retry policy
around it and a decode of what came back. A Promise contract there would leave the
built-in plugins writing Effect internally and unwrapping it at the boundary, making them
second-class citizens of the surface they define.

## Schema

Effect Schema replaces Zod everywhere, including the RPC contracts in `@rova/shared`, the
timestamp codec, and `JsonValue` parsing. Service failures become tagged errors built with
`Schema.TaggedErrorClass`. The two adapters at the edges keep doing their translation job:
`packages/core/src/backend/rpc/errors.ts` maps a failure to an oRPC code, and
`packages/core/src/backend/lib/http/failure-response.ts` maps it to an HTTP status.
Knowledge of status codes stays at those two edges, exactly where it lives today.

oRPC moves to the 2.x beta together with `@orpc/experimental-effect`, which lets a
contract take Effect Schema directly, gives Effect-native handlers, and generates the
OpenAPI document from Effect schemas.

**Amendment, 2026-07-28.** Stage 4 landed as written, with one correction and one
addition. The correction: a contract's schemas cross into oRPC through the repo's own
`toStandardSchema` in `packages/shared/src/types/schema.ts`, not through the one
`@orpc/experimental-effect` exports. Effect has no per-schema `.strict()`, so a closed
object is closed only because the decode was told to close it, and oRPC calls
`~standard.validate(payload)` with no options — leaving the parse options as the only
place strictness can live, and oRPC's wrapper takes none. Both wrappers leave the schema
being an Effect schema, which is all `EffectSchemaToJsonSchemaConverter` needs, and that
converter did replace `ZodToJsonSchemaConverter` in
`packages/core/src/backend/rpc/openapi.ts` as this section says. The bridge is not part of
the plugin surface either: `createTrigger` and `createAction` take a bare Effect schema and
bridge it themselves at registration, so an integration author writes
`schema: Schema.Struct({ ... })` and no wrapper. The addition: Zod is
still a devDependency of `packages/shared`, as the foreign Standard Schema library the
registry tests are written against beside arktype. It is absent from every runtime path
and from every published manifest.

**Behaviour the migration changed on purpose.** Effect Schema is not Zod, and four places
now answer differently from what the Zod version did. Each is chosen; each has a test
pinning it, so a later change to any of them is a decision rather than a drift.

- A node position holding `Infinity` or `NaN` is rejected. `Schema.Finite` is what the
  position now decodes through, where `z.number()` admitted both. An infinite position was
  already corruption, and the editor's save store treats a graph it cannot decode as
  nothing to save, so the rejection is absorbed rather than surfaced.
- Node data whose `type` is missing or is none of the three node kinds fails at `data`
  rather than at `data.type`. Effect selects a union arm by the literal its `type` holds,
  and an input matching no literal selects no arm at all, which leaves nothing to blame a
  field for. The union carries a `message` annotation naming what a node type must be,
  which is also what keeps the rejected node data out of the string: an unmatched union
  prints the whole value it rejected, past the leaf hook `schema-message.ts` installs.
- A trigger config failure mentions the custom-trigger arm beside the real problem. The
  three-arm config union discriminates on `triggerType`, and the third arm takes any
  trigger type a plugin registered, so it has no literal to select on and is tried against
  every config. Its refusal ("Custom triggerType must not be...") rides along with the
  message that names the actual bad field.
- `toStandardSchema` throws when a schema that already carries a Standard Schema
  `validate` is bridged again with parse options. Effect's bridge is first-call-wins, so
  the second set of options would be dropped in silence, and which crossing ran first is
  decided by module initialisation order. `contracts.ts` binds each shared shape's bridged
  form once at module scope rather than bridging at each `.output()`.

## Dependency wiring

`createRovaApp` builds a Layer graph and holds it in a `ManagedRuntime` owned by that app
instance. Four pieces of shared process state are deleted:

- the `globalThis` Proxy over the Drizzle handle in `packages/core/src/backend/lib/db/index.ts`
- the module-level Inngest client in `packages/core/src/backend/lib/inngest/client.ts`
- the module-level step and integration registries
- the `claimProcess` guard in `packages/core/src/app.ts`

The `claimProcess` guard goes away with the state it policed, and that is the whole
story: one Rova per process remains the only supported arrangement. Constructing a
second app in a process is undefined behavior (decided 2026-07-28). The runtime work
is justified by dependency injection and testability, and nothing is added, tested,
or documented to make multiple apps work.

**Amendment, 2026-07-28.** Stage 3b deleted `claimProcess` and `service-result.ts` as
planned, but the database handle and the Inngest client outlive it into stage 7. The run
engine consumes both from outside any runtime, since the step store, the step logger, the
credential fetcher, and the function registry all import them directly, so they cannot
be deleted until stage 7 brings that interior across. `DatabaseLayer` and
`InngestClientLayer` are built from those globals in the meantime, which is what lets the
services above them be injected and tested now.

**Amendment, 2026-07-30.** Stage 7's first half took the Inngest half of that back.
`createRovaApp` builds one `InngestSurface` -- the client, the function registry over it,
and the `/inngest` serve handler as one value -- and threads it to the runtime and the API
app, so the Layer is `makeInngestClientLayer(client)` and nothing looks a client up. The
database handle is still a process global, and the run engine's interior is still what
holds it there.

## Sequencing

Each stage lands green on `main` before the next one starts.

1. Platform exit (ADR-0003).
2. oRPC 2 beta, contracts still described in Zod through Standard Schema.
3. Services get tagged errors, Layers, and the instance-owned runtime.
4. Zod to Effect Schema, contracts included.
5. One vendor HTTP module built on Schema decode.
6. `defineStep` and the Effect-native plugin surface.
7. The workflow-engine interior.

Schema moves at stage 4 so that steps and vendor code arrive at stages 5 and 6 with
Schema-typed inputs already in place, sparing a second pass over the same files.

**Amendment, 2026-07-28.** Stage 5 landed as `packages/plugins/src/vendor-http.ts`, built
on `HttpClient` from `effect/unstable/http`, with Twilio, Resend, and Slack reduced to
adapters over it. Three things about it were decisions rather than transcription.

The first is new behaviour, and the behaviour this stage set out to add: a
per-attempt timeout and a retry policy, neither of which existed anywhere in the vendor
path before. Ten seconds bounds an attempt, and a failure a repeat could plausibly fix
(nothing answered, a 429, a 503, or another 5xx that named a `Retry-After`) is retried
twice with jittered exponential backoff from 500ms, with a `Retry-After` of up to ten
seconds replacing that delay. A request enters the loop only when repeating it cannot do
the work twice: a GET or HEAD, a write carrying an idempotency key, or a spec that says so
because the vendor spells a read as a POST, which Slack does for all of its API. Inngest's
function-level retry stays the outer policy and everything longer than a hiccup is still
its job.

The second is a bug fix in Slack. The old `callSlack` read the `ok` envelope out of the
body and never looked at the HTTP status at all, so a 500 whose body satisfied both that
envelope and the caller's schema was reported to the run as a message sent. Status now
decides first: anything outside 2xx is a refusal whatever the body says, and the envelope
check only turns Slack's own 200-with-`ok: false` into that same refusal. Apart from these
two, the wire, the failure vocabularies, and every user-visible message are what they were,
verified against the pre-change build through `integration.testCredentials` for all three
vendors.

The third is a scope call. Linear, Clerk, and Acuity do not go through the module and are
not scheduled to. Each reaches its vendor through an SDK that carries protocol logic worth
borrowing rather than a REST call written out here, so there is no request pipeline to
share: `@linear/sdk` is a typed GraphQL client, `@clerk/backend` verifies JWTs, and
`@fountain-bio/acuity` is the Acuity client. Their retries and their error shapes come
through those SDKs, which is where they should stay. `lib/steps/http-request.ts`, the
user-facing HTTP node, is stage 7's.

**Amendment, 2026-07-29 (stage 6a).** `defineStep` landed as
`packages/core/src/backend/lib/steps/define-step.ts`, with twilio as the one plugin
migrated onto it. Five decisions in it are worth writing down.

The credentials reach a handler as an `Effect` rather than as a value. A step that
decides it has nothing to send, which is what a test run in log-only mode does, must not
read an integration's secrets to reach that conclusion, and the old twilio step took the
same care by hand. `Effect.cached` makes the fetch happen at most once however often it
is yielded, so the laziness costs an author one `yield*` and nothing else.

The handler's failure channel is one tagged error, `StepFailure`, carrying the message
the run log shows. A second tag would render to the same wire bytes and buy only a
`catchTag` nobody has needed. A vendor failure becomes one of these in the plugin, which
is the only place that can read the vendor's error body accurately: `describeTwilioFailure`
now takes a `VendorError` and the `TwilioResult`/`TwilioFailure` pair is gone.

Registration became a value under a checked key. `registerStep(id, load)` takes a loader
resolving to a `StepDefinition<NoInfer<Id>>`, so an id that disagrees with the step's own
id fails to compile, and the export name that used to be data is now a real import. The
`NoInfer` is what makes the check bite: inferring `Id` from both arguments widens a
mismatched pair to the union of the two ids, which type-checks. `loadStepFunction`
and its undefined-on-mismatch failure are deleted, along with the engine's second dispatch
table: `Database Query` and `HTTP Request` register beside the built-in labels in
`step-registry.ts`, the same way everything else does. The
sixteen steps that have not migrated register through `registerStepFunction`, which holds
the one remaining unsound call in the system. (6b took those sixteen to `defineStep` and
took the function off the plugin surface; the two built-ins kept it, module-private. See
the 2026-07-30 amendment.)

Issue #8 landed for the plugin surface: an action declares `output` in its `index.ts` and
`registerIntegration` derives the editor's field list from it. The derivation is shared
with `createAction`'s in `packages/shared/src/workflow/output-fields.ts`. `outputFields`
stays on the definition type for now, because deleting it in 6a would take the autocomplete
away from sixteen actions whose steps have not moved; an action declaring both is a
registration error, so the two cannot drift. (6b deleted both the field and that error.) The derivation is loud for a plugin action
and quiet for `createAction`: a plugin whose output schema has a non-object root, loses a
field on the way through the JSON Schema reader, or leaves a field without a description
annotation throws at `registerIntegration`, because 6b writes sixteen of these schemas and
a rule that fails on import beats sixteen chances to ship an empty autocomplete. An
embedder's runtime action keeps the empty list, since it may pass an `outputFields` list of
its own alongside the schema. Twilio's derived list is a superset of the
list it replaced: the three paths that were written by hand keep their exact descriptions,
and `from`, `messagingServiceSid`, and `reasonCode` -- which the step has always returned
and never offered -- are there now. That is the bug the issue was filed about.

The Promise seam stays inside the constructor, which is stage 7's to remove: `withStepLogging`
around the whole run, `fetchCredentials` behind the credentials effect, and `Effect.runPromise`
at the end. An author sees none of them. `Effect.promise` behind the credential fetch is
deliberate: a credential store that rejects is a defect, and a defect leaves by the throw
path, where Inngest's function-level retry runs the step again, which is the right answer
for a store that was briefly unreachable. The transport those Promise callers provide is
the layer `defineStep` already gives a handler, exported as `VendorTransport` from
`@rova/core/plugin` rather than copied into the plugins package. One dead branch went with
the rewrite: nothing in the tree ever set `_context._workflowComplete`, so
`withStepLogging` no longer looks for it.

The step context is decoded with `Schema.optional` rather than `Schema.optionalKey` for
the two fields the engine may leave empty. The decode is all-or-nothing, so a caller
spelling an empty value as a key holding `undefined` lost the whole context: the run
stopped logging and `runMode` fell back to `"live"`, which for twilio is a test run
reaching a real phone.

## Considered Options

- **`effect` 3.22 stable** rejected: adopting v3 guarantees a v3-to-v4 migration of the
  entire backend later, and the guidance we intend to follow targets v4.
- **A Promise-based `@rova/core/plugin`** rejected: it would push every plugin to unwrap
  its own Effects at the boundary, and the built-in plugins are the largest consumer of
  that surface.
- **Zod kept at the wire, Effect Schema inside** rejected: it institutionalizes two schema
  dialects. A prior review found four validation dialects coexisting here, and the repo's
  ethos is one way to do a thing.
- **Staying on oRPC 1.x** rejected: v1 generates its OpenAPI document through `@orpc/zod`
  and has no Effect Schema path, so removing Zod would break the `/rest` spec.
- **Wrapping the existing globals in Layers as a bridge step** rejected as an end state:
  the seam would be cosmetic. Two app instances would still collide over the same globals,
  and every Layer would be a pass-through to module state. Deleting the entire bridge
  would leave behaviour identical, which is the test that tells you it carries no
  structure. It was adopted as an intermediate for stages 3b through 7, which is a
  different claim: a pass-through Layer carries no structure of its own, and it does make
  the services above it injectable and testable now, which is the whole reason the runtime
  exists. See the 2026-07-28 amendment above.

**Amendment, 2026-07-30 (stage 6b).** The other five plugins moved onto `defineStep` and
the machinery that carried the un-migrated half is gone. Sixteen steps became sixteen
handlers: acuity's eight, clerk's four, linear's two, resend's one and slack's one, each a
schema pair in a `schemas.ts` beside the plugin's metadata and an `Effect.fn` handler
under `steps/`.

`registerStepFunction` came off `@rova/core/plugin`, and so did `fetchCredentials`,
`withStepLogging` and `StepInput`, which existed for the steps that fetched and logged by
hand. The published surface is now `defineStep`, `StepFailure`, `StepDefinition`,
`StepRunContext`, `registerStep`, `registerIntegrationTest` and `VendorTransport`, which
`pnpm pack` on `@rova/core` confirms. The unsound call did not die with the plugins,
though, and this is the one place 6a's plan was wrong: `Database Query` and `HTTP Request`
register through it too, and each answers a shape `StepResult` has no room for -- rows
beside a count, a status beside the data. Moving them is a decision about what a step may
return rather than the mechanical conversion the plugins were, so the registration stayed,
renamed `registerBuiltInStep`, module-private in `step-registry.ts`, with the one
suppression it has always carried and two call sites nothing outside that file can reach.

`outputFields` came off `PluginAction` and `output` became required, so the either/or
registration error had nothing left to guard and went with it. Every action's field list
is derived, and the derived lists are supersets of the hand-written ones they replaced:
every path and description carried over unchanged, and the payloads that used to be one
opaque entry opened up. An Acuity appointment offers the fields inside where it offered
one; a Linear issue offers six inside `issues[0]`; a Clerk user gained `createdAt` and
`updatedAt`; resend, slack and twilio each gained the `reasonCode` a test run has always
answered with. Slack's is not only autocomplete: its step used to answer
`{ success: true, ts, channel }` at the root, which leaked `success` into the flat CEL
condition namespace mergeConditionContextValue builds. `defineStep` wraps the payload, so
that namespace sees only the fields the schema names.

Two things the derivation does quietly, both learned here and written into
`packages/plugins/src/AGENTS.md`. The count that guards a schema is taken at the root, so
a leaf inside an object or a list can drop out and registration still succeeds; three
Acuity fields did, and only reading the derived list against the SDK's type found them.
The shape that dropped them was `Schema.optional(Schema.NullOr(x))`, an `anyOf` inside an
`anyOf`, where `Schema.NullishOr(x)` flattens to the union the reader uses.

`examples/app.ts` was the last hand-written `outputFields` in the tree. `createAction`
takes an `outputSchema` and derives the same list, and the list it replaced had already
fallen a field behind what `execute` answers with, which is the drift the derivation
exists to make impossible.

One acceptance narrowing went with the input schemas: a config value of `null` or a bare
boolean, which the old helpers mapped to absent or themselves, now fails the decode, and
that applies to all sixteen steps rather than Acuity alone.

## Consequences

- Pinning a beta means upgrades are deliberate work: a bump can break compilation, so read
  the changelog before moving the pin, and move every `@effect/*` package with it.
- `@rova/core/plugin` changes shape, which is a breaking change to a published surface.
  Third-party integration authors take on Effect as a build-time dependency.
- Zod leaves the dependency tree at stage 4. The AGENTS.md guidance that names Zod at the
  boundary, and the `JsonValue` narrowing rules, need rewriting at that point.
- Test setup gains Effect's own testing tools; see ADR-0003 for the runner they require.
- Drizzle stays, held by a Layer rather than a global; see ADR-0005.
