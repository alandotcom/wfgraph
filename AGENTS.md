# Agent Instructions

Rova Workflow Builder: a pnpm workspace monorepo with four packages under `packages/`,
beside `@rova/example-app` (`examples/`), the host app `pnpm run dev` runs.

- `@rova/shared` (`packages/shared`) runtime-agnostic types, workflow contracts, utilities
- `@rova/core` (`packages/core`) library entrypoints and the backend
- `@rova/client` (`packages/client`) the React SPA, handed to `createRovaApp` as `client`
- `@rova/plugins` (`packages/plugins`) integration plugins and their steps, built
  against `@rova/core/plugin` and nothing else

Read the code for structure. What follows is what the code cannot tell you.

## Package management

pnpm only, at the version the root `packageManager` field names. `pnpm add <pkg>`,
`pnpm run <script>`. Never npm, yarn, or `bun install`. Node runs everything: the
server through `tsx`, the client build through Vite, the suite through vitest. The
`engines` field names Node 24 as the floor, which is the version CI installs.

**Isolated `node_modules` is pnpm's default.** Each workspace package gets a
`node_modules` holding only what its own `package.json` declares, so an npm specifier
for something undeclared fails to resolve. The dependency belongs on the package that
imports it.

**`#src/` means this package's own `src`, never another's.** Each package's
`package.json` carries `"imports": { "#src/*": "./src/*.js" }`, which is a Node
subpath import: the resolver defines a `#` specifier against the manifest of the
file that wrote it, so `#src/lib/foo` in `packages/client` can only ever be
`packages/client/src/lib/foo`. The scope is the resolver's own behaviour, which is
why nothing in the repo restates it. Import a sibling by name instead:
`@rova/shared/types/json`, `@rova/core/plugin`.

The mapping's `.js` suffix is what Node's `imports` field needs to reach a `.ts` or
`.tsx` file, and it stays in the manifest: a specifier is written extensionless.
Two habits the old tsconfig alias allowed have to be unlearned, because ESM
resolution has neither. A directory does not stand in for its `index`, so write
`#src/backend/lib/db/index`. A stylesheet needs the separate `#src/*.css` entry
`packages/client` declares, since the `.js` suffix would otherwise be appended to
it.

**Every pnpm setting lives in `pnpm-workspace.yaml`.** pnpm reads no `pnpm` field
from `package.json` and reads only auth and registry settings from `.npmrc`, so the
workspace globs, the catalog, `overrides` and `allowBuilds` are all in that one file.
`allowBuilds` lists each dependency that ships an install script with a true or false
verdict; a dependency that gains a script and is missing from the list ends the install
with `ERR_PNPM_IGNORED_BUILDS`.

**Shared versions live in the pnpm catalog** in `pnpm-workspace.yaml`. When a dependency
is used by two or more packages, put the version there and reference it as `"catalog:"`.
`pnpm publish` and `pnpm pack` rewrite those to real semver, so a published package is
unaffected. A family of packages that must hold one version goes in whole even where
only one workspace package imports a member; the `@orpc/*` block and the `effect` pair
are the two cases, and each carries a comment saying so.

## Required checks before finishing

```bash
pnpm run type-check   # tsc --noEmit, TypeScript 7
pnpm run lint         # oxlint --type-aware, prints nothing when clean
pnpm run test         # vitest, one project per environment
pnpm run build        # pnpm -r build, each package building itself
pnpm run knip         # unused files, exports, dependencies
pnpm run fix          # oxfmt, must leave the tree clean
```

Do not leave the repo with a failing check. `pnpm run lint` printing nothing means it
passed; oxlint has no summary line on success.

## Conventions that differ from the defaults

**No backwards compatibility.** There is no stored data and no external consumer. Do not
add compatibility shims, migrations, fallbacks, or lenient paths for old shapes. When the
stricter contract is the correct one, make it strict and let the old shape fail. A test
that encodes the old permissiveness was asserting a bug; tighten it to the strict contract.

**JSON has a type; use it.** `packages/shared/src/types/json.ts` holds `JsonValue` and
`JsonObject`. Anything that walks a value which arrived as JSON takes `JsonValue`, and
narrowing is then plain language checks. Do not write a `value is Record<string, unknown>`
predicate, and do not reach for es-toolkit's `isPlainObject`. Parse untrusted input at the
boundary with Effect Schema, so the interior holds typed values.

**Effect Schema is the only schema library.** `packages/shared/src/types/schema.ts` holds
the three names most of this repo needs: `NonEmptyTrimmedString` for an identifier crossing
the wire, `rejectUnknownKeys` for the decode options that make a closed object closed, and
`toStandardSchema` for handing a schema to oRPC, Inngest, or the registries.

Four rules, each of which cost something to learn:

- **Strictness is a decode option, not a schema.** Effect has no `.strict()`. A
  `Schema.Struct` is closed only because the decode was told to close it, so every decode
  of a wire shape passes `rejectUnknownKeys`. A shape meant to stay open says so in its own
  shape, with `Schema.StructWithRest` over a `Schema.Record` rest, and stays open under
  those same options because an index signature skips the excess-property check. One
  boundary is deliberately open and it is named where it lives: an Event's intake gate
  (`defineEvent`, below), because that payload is a host's own message rather than a contract
  between our two halves.
- **`toStandardSchema` is where those options are baked in**, because oRPC and Inngest call
  `~standard.validate(payload)` with nothing else to say. Effect assigns `~standard` onto
  the schema and returns early if a `validate` is already there, so a schema crosses that
  bridge once and the first crossing decides its options. The RPC contracts and the Inngest
  event types call it directly for that reason. `createAction` calls it itself, where the
  action is defined, so an author takes a bare
  `Schema.Struct` and writes no bridging ceremony; `Schema.isSchema`
  is the discriminator, testing for the type id Effect brands its schemas with, so a Zod or
  arktype schema is passed through untouched.
- **`Schema.optionalKey` for a shape read from JSON, `Schema.optional` for one built in
  process.** `optionalKey` accepts an absent key only; `optional` is
  `optionalKey(UndefinedOr(...))`, so it also accepts a key holding `undefined` and keeps
  it. A parsed JSON payload never carries `undefined`, and its JSON Schema renders clean;
  an object literal TypeScript wrote says "no value" with `undefined`, and rejecting that
  broke every run whose webhook carried no correlation key. A shape with both origins
  takes `optional`, because the stricter spelling is the one that fails:
  `packages/shared/src/workflow/schemas.ts` is the worked example, decoded from the JSONB
  column, from an RPC payload, from an Inngest event, and from React Flow state on the
  editor's autosave path, and it is `optional` throughout for the sake of the fourth.

  **Under a canonical JSON codec the two swap places.** `Schema.toCodecJson` rewrites
  `optional(X)` to `optionalKey(NullOr(X))`, so a step's config decode accepts an absent
  key or a null and refuses a key that is present and holds `undefined`. Nothing writes
  that third shape: the engine's `processTemplates` drops an undefined-valued key, and the
  two test-destination overrides beside it are written only where the node has one. So
  `optionalKey` is the spelling to prefer in a step's schemas, since its JSON Schema
  renders clean and the engine never sends what it refuses; `optional` is what twilio
  keeps, because under the codec it also tolerates an explicit null.
  `packages/core/src/backend/lib/steps/define-step.test.ts` holds all three cases.

- **Annotate the base type before any check.** `.annotate()` on a schema that already
  carries a check lands on the check, and a wrong-typed value never reaches a check.
  `Schema.Finite.annotate({ message })` answers `"5"` with Effect's own text, not the
  message. `packages/shared/src/workflow/conditions.ts` has the worked example.

**A message never quotes the value it rejected.**
`packages/shared/src/types/schema-message.ts` holds `formatSchemaFailure`, which renders a
decode failure with objects named by kind and primitives cut short. Effect's own renderer
prints the value in full, and the strings this project builds from a failure are persisted
as run errors, written to the log, and answered over HTTP. Use it wherever a decode failure
becomes text a person reads.

**Zod is the example app's schema library, and a test fixture inside `packages/`.**
`@rova/example-app` is written in it, which is what makes "an adopter needs no Effect"
enforceable rather than promised. In `packages/` it stays a devDependency of
`packages/shared`, used by `action-registry.test.ts` and `standard-schema-compat.test.ts`
beside arktype, and no published manifest names it.

**Timestamps cross through a codec.** `packages/shared/src/types/timestamp.ts` owns the
one ISO-string-to-`Date` conversion, as a checked `Schema.decodeTo` pair. Do not hand-roll `new Date(x)` or
`.toISOString()` for a value crossing the wire.

A datetime field says so with `format: "date-time"` on the encoded side, which is the whole
of how the editor learns a field is a moment in time: it gives the field before/after
operators in the condition builder and ranks it to the top of a menu asking for a date. A
foreign library emits the keyword itself, arktype through
`type("string.date.iso").configure({ format: "date-time" })` and Zod through
`z.iso.datetime()`. Effect emits it for no date schema of its own
([effect#6790](https://github.com/Effect-TS/effect/issues/6790)), so a schema here annotates
by hand and carries its own check: the keyword buys the editor's treatment and refuses
nothing. `isoTimestampString` in `@rova/shared/types/timestamp` is that pair.

**An integration is one `defineIntegration` value.**
`packages/core/src/backend/lib/extensions/define-integration.ts` takes a type, a label, a
credential form, an optional connection-test loader, and a record of actions keyed by
slug. Nothing registers on import: a host passes the value to `createRovaApp` under
`extensions.integrations`, so the line that turns an integration on is a line in the
host's code. The action id is `${type}/${slug}`, computed at assembly, so the slug exists
only as that record key. `credentialFields` is a `const`-type-parameter identity function
whose only job is keeping each `envVar` a literal type, because `CredentialsOf<typeof
fields>` is the vocabulary a handler reads its credentials by; a misspelled key fails to
compile. `packages/plugins/src/twilio/index.ts` is the worked example, and the whole
plugin is that one file beside `client.ts`, `test.ts`, `icon.tsx` and `ui.ts`.

**A step is written with `defineStep`.** `packages/core/src/backend/lib/steps/define-step.ts`
takes an input schema, an output schema, the metadata the editor draws the action with
(`label`, `description`, `category`, `configFields`), and a handler returning an
`Effect<Output, StepFailure, HttpClient>`. It owns everything around that handler: the
config decode, the credential fetch, and the `StepResult` envelope
(`{ success: true, data }` or `{ success: false, error: { message } }`, in
`packages/shared/src/workflow/step-result.ts`) that the engine reads. A handler never
writes that envelope and never touches a Promise. Each `configFields[].key` is
`Extract<keyof TInput, string>`, so a field the step cannot read fails to compile.

`implement(actionId)` answers a factory rather than a step, because the one thing around
the handler that belongs to the app is the credential store a node's integration is read
from. It arrives as `StepEnvironment` (`backend/lib/steps/step-runner.ts`), which
`createWorkflowActions` builds off the assembled surface the credential mapping is read
through. A plugin's own test hands over `{ credentialsFor: () => Effect.succeed({}) }`.
The handler's own Effect asks for nothing an app provides -- `defineStep` provides the
vendor transport itself and turns every failure into the envelope -- so it runs on
`Effect.runPromise` rather than on the app's `ManagedRuntime`. The runtime belongs in that
record the day a handler may yield an app service, which is the day the type changes
anyway.

The handler's `context` parameter is typed with the open credential record unless an
author annotates it, and that is deliberate: a type parameter appearing only inside a
context-sensitive argument cannot be inferred before that argument is typed, so inferring
the credential vocabulary there would cost an inline handler both parameter types and
leave the whole handler unchecked.

**A handler sits inline, and an integration is one file.** `handler` is the only
spelling: an action's two schemas, its config fields and the `Effect` between them are
read in one place, and no plugin exports a schema for a handler's module to type itself
against, because there is no such module. A vendor SDK (`@clerk/backend`, `@linear/sdk`,
`@fountain-bio/acuity`) is a plain import of that file, and `@rova/plugins` imports all
six integrations as values, so those three SDKs are hard dependencies of that package and
load with it whatever a host goes on to list. What the static import buys is the timing of
a failure: a missing SDK is a crash at boot rather than one run failing.
The deleted alternative was a `load` loader, whose reason was keeping a plugin
file out of a browser bundle; the catalog became the browser's only channel, so no
plugin file can reach one.

**Both directions of a step cross through the schema's canonical JSON codec.** A step
boundary is JSON on both sides, so what `defineStep` runs is `Schema.toCodecJson(schema)`
rather than the schema itself, built once at definition. That is what lets an author write
a transform: twilio's comma-separated Media URLs field decodes to a list on the way in,
and a `Date` in an output encodes to an ISO string on the way out. Encoding through the
plain schema is not enough, because `Schema.Date` is a declaration rather than a codec: a
live `Date` then survives JSONB and Inngest by accident through `Date.prototype.toJSON`
and comes back a string on replay, so one memoized step hands template resolution two
different types. `core-replay.test.ts` holds that to a template resolving the same string
on the attempt that ran the step and on the replay after, against a runtime that models
Inngest's own asymmetry. A handler answering with something its output schema cannot
encode fails the node once as a `StepFailure` naming the field path, since a retry would
spend the budget on a certainty; reaching it takes an `as`, an `any`, or a widened vendor
type.

**An action's output fields come from its output schema.** An action declares `output` on
its `defineStep`, and assembly derives the editor's template-autocomplete paths from it
(`packages/shared/src/workflow/output-fields.ts`).
Paths omit the `data.` prefix, because the schema describes the payload rather than the
wrapper; template variables unwrap it automatically. That unwrap is also why a schema must
not declare a top-level `data` field of its own: `data` is the envelope's own key, so a path
starting with it addresses the wrapper instead, and a payload field by that name is
unreachable through a template. Nothing refuses the declaration at definition time. The
schema sits beside the handler it types, and `output` is required: there is no hand-written
list to declare instead, and a schema the derivation cannot read throws naming the offender.
`requireOutputFieldsFromSchema` takes
that name as a phrase rather than an id, because an Event's payload schema comes through
it too and the message has to say which kind of thing is at fault.

A host action spells the same thing `outputSchema` on its `createAction`, and derives its
fields there rather than at assembly, because that call is where any Standard Schema library
is bridged. It encodes on the way out too, through the same canonical JSON codec, so a
`Date` a host's `execute` answered with leaves as an ISO string; a foreign Standard Schema
library hands over a validator and a JSON Schema and nothing that runs in that direction, so
those pass through untouched, which is the same call `output-fields.ts` makes for the field
list. What a schema cannot say about itself is not said.

That encode is what retired the dev-mode JSON-safety walk the in-memory runtime used to
perform, and it covers exactly the actions that have an Effect output schema. A
`createAction` with no `outputSchema`, or one written in arktype or Zod, hands `execute`'s
answer back as it is: a `Date` in it becomes a string on the replay with nothing said, and
that is the host's to know. The in-memory runtime still round-trips a memoized value through
JSON, which models the loss without reporting it, and the walk never ran in production at
all.

**The extension surface is one JSON catalog, served on one route.** An Event, an action
and an integration reach the editor as `ExtensionCatalog`
(`packages/shared/src/extensions/catalog.ts`), which `GET /api/extensions` sends and
`packages/client/src/lib/extensions.ts` decodes once before the first render, through the
wire schema in `catalog-wire.ts`. That module owns the response envelope as well
(`readExtensionsResponse`), which carries the catalog and nothing beside it, so the client
names no member of the answer by hand and reads it all-or-nothing. The client holds the catalog
as a module value rather than a query-cache entry: the surface is fixed for the life of the
server process, and the pure functions that read it run during render. Every lookup over it
(`findAction`, `findEvent`, `findIntegration`, `credentialsFromConfig`) is a pure function
in that shared module, so the server and the browser run one implementation, and a lookup
nothing reads yet is not written. That one channel is what lets a plugin hold everything it
needs in one file: the browser never imports that file. An icon and a custom output
renderer are React components and cannot be serialized, so those stay an explicit browser
import in `plugins/ui-registry.ts`.

`createRovaApp` assembles the catalog with `assembleExtensions`
(`packages/core/src/backend/lib/extensions/extension-set.ts`) and hands it to the Layer
graph as the `Extensions` service (`backend/lib/effect/extensions.ts`). Assembly is
where a definition mistake is caught, naming the offender: each of an Event's name, an
action's id and an integration's type is held to one owner, an output schema the
derivation cannot read is refused naming the action, and so is a required config key with
no field for a builder to fill in and a credential field with no `envVar`, which would
render an input and reach no handler. It is also where an integration definition's actions
get their ids and their derived field lists, and where `stepFor` and `connectionTestFor`
come from, since a definition carries both. Condition and Wait are the two actions the
engine ships itself, catalog entries in `built-ins.ts` with no step of their own -- the
engine dispatches to both during the traversal rather than through `stepFor` -- and a
host's own actions arrive as `extensions.actions` -- `createAction` values, which carry
their `execute` into the same `stepFor`, so dispatch has one kind of thing to find. HTTP
and database work are a host's to build with `createAction`; the engine ships neither.

The server reads that catalog for everything it used to ask a registry: the credential
mapping in `credential-fetcher.ts`, the secret-key test in
`integration-config-masking.ts`, the action labels and step dispatch in
`extensions/workflow-actions.ts`, and both workflow validators. A service yields
`Extensions`; the pure checks beside it take the catalog as a parameter, so a validator has
no way to reach a surface of its own. That a surface must exist is the type system's answer
now rather than a throw: yielding the service puts `Extensions` in a body's `R`, and only a
runtime carrying one can run it. The alternative a lenient lookup would give is a run that
dispatches nothing, a save that passes every check, and a config that serves its secrets
unmasked. A test of one of those provides `stubExtensions` or `stubExtensionCatalog` from
`backend/lib/effect/test-layers.ts`, and an empty assembly still carries the built-in two,
Condition and Wait; a host naming no integration of its own gets none.

The browser reads the same catalog and nothing else. `main.tsx` imports
`@rova/plugins/ui` for the icons a wire cannot carry and nothing from `@rova/plugins`
itself, so no integration metadata reaches a bundle: the action selector, the config panel,
the node badges, the template picker and the connections dialog all read
`getExtensionCatalog()` and the pure lookups beside it. That is what lets an integration
hold its vendor client, its SDK and its secrets in the same file as its metadata.

`packages/shared/src/plugins/action-fields.ts` is what is left of the registry that used to
carry all of this: the config-field types both ends share, `parseActionId`, and two helpers
over a field list. Nothing registers anything: `assembleExtensions` is handed every
definition and answers for every half of it.

**An Event is a `defineEvent` value, and carries no lifecycle role.**
`packages/core/src/backend/lib/extensions/define-event.ts` takes a name, a payload schema,
and the Correlation Path where that payload carries its Entity Value. It registers
nothing: the host passes the value to `createRovaApp` under `extensions.events`. The
schema crosses the Standard Schema bridge once, there, and `payloadFields` is derived on
the spot, so a schema that cannot describe itself fails at definition. A Correlation Path
is typed as `StringPath` (`packages/shared/src/types/payload-path.ts`), which admits only a
path resolving to a string, which is what an Entity Value is, and `@rova/core` publishes
that name as `EventStringPath`.
`source` separates identity from transport for an umbrella bus that cannot change its event
name. Inngest flow control is authored against the payload and translated by
`rewriteInngestOptions` (`packages/core/src/backend/lib/extensions/inngest-options.ts`),
which prefixes each `key` and rewrites `priority.run`, so a bad path fails where it was
written; Inngest `concurrency` and `batchEvents` are refused there, the first because
Concurrency on the Lifecycle Node owns that question and can write a status. The prefixing
and the CEL rewrite are `packages/shared/src/workflow/inngest-event-data.ts`, which every
Event translates through, and `extractSchemaKeys` in `types/schema.ts` is
where the field names a CEL identifier is checked against come from.

**Every CEL string literal is `celStringLiteral`**
(`packages/shared/src/workflow/cel-string-literal.ts`), which is `JSON.stringify`: the
double-quoted form, backslashes doubled, a control character written as an escape. Three
places assemble a CEL expression by hand -- the source filter beside it, the wait
subscription's `if` in `workflow-engine/core.ts`, and the run function's trigger filter in
`inngest/workflow-function.ts` -- and they sit on both sides of the runtime port, which is
why the helper is in `@rova/shared`. Hand-rolling the escape is how a value carrying a
newline gets past a test and fails at Inngest, where the expression is evaluated and the
failure is a run that never triggers.
Which Event starts a run and which Events cancel it is the Workflow Builder's
per-workflow declaration, never the Event's (ADR-0007).

`decodePayload` beside the schema is the intake gate, and it is the one boundary in this
repo that decodes **open**: declared fields are validated and a key the schema never heard
of is ignored. An Event's payload is the host's own message and their senders add fields, so
an additive change upstream must not stop intake; drift on a declared field still fails
loudly. What it decodes to is thrown away and the raw JSON travels on, because nothing
downstream consumes a typed value and a transform would rewrite what the sender sent -- a
`Date` round trip alone is enough to break a wait match comparing a literal captured at park
time. It is built from the author's Effect schema when there is one, because the bridged
object's parse options freeze at the first crossing, and from `~standard.validate` for a
foreign schema; `isEffectSchema` in `types/schema.ts` picks the path, and both arms fail with
one `PayloadRejected`.

**The Lifecycle Rules are per workflow, and the engine reads them off the entry node.**
`packages/shared/src/workflow/lifecycle-rules.ts` holds `lifecycleRulesSchema` and the
sentences a save is refused with (`checkLifecycleRules`), which
`backend/lib/workflow-lifecycle-validation.ts` runs against the assembled catalog wherever a
graph is written and again in preflight. `services/workflows/lifecycle/` holds the rest:
`deliver-event.ts` is Precedence (rules first, then the Wait Subscriptions of the runs that
survived them), `concurrency.ts` is `startWithConcurrency`, and `subscriptions.ts` derives the
`workflow_event_subscriptions` rows a graph calls for, each carrying the builder's
Correlation Path override for its Event so a delivery never reads a graph to find one. Those
rows are written by `WorkflowRepo` in the same transaction as the graph, and the fan-out
re-reads a workflow's rules before acting, so a row that outlives the role it was written for
costs a wasted read and nothing else.

**Opening a run is idempotent per arrival, and the send is the only irreversible step.** The
lifecycle fan-out runs inside an Inngest step, whose retry re-runs the whole start, so
`workflow_executions.delivery_id` carries the arrival and a unique index on
`(workflow_id, delivery_id)` holds it to one row. `startForEntity` answers with the row this
arrival already opened rather than joining a second beside it, and `sendRunRequested`'s
`workflow-run-${executionId}` key then makes the re-send a no-op at Inngest. Around that
send, `enqueueStartedRun` reads in one direction: before it a refused enqueue signals the run
to stop and closes the row, because the in-flight guard on that close defers to a terminal
status and would otherwise relabel a run Inngest took a moment ago; after it `markEnqueued`
and the `run_started` row are bookkeeping, and a refused write is a log line rather than a
failure, since failing would retry a step that enqueues nothing new.

`enqueued_at` is what that stamp writes, and it is how a row the bus was never told about is
recognisable. A crash between the commit and the send used to leave first-wins deferring to
that row for the life of the entity; now the next start for the entity closes any in-flight
row unstamped for longer than `UNSENT_RUN_GRACE_MS`, records it as `failed` with the reason,
and signals it through `announceReclaimedRuns`, because the same stamp can go missing on a
run Inngest really did take.

`listEventSubscribers` asks two questions per arrival: which workflows name this Event as a
start in the graph they hold now, from that index, and which runs are still parked on it, from
`workflow_wait_states.subscribed_events` -- the names the row was written with, so an edit to
the Wait node cannot orphan the runs already parked on it. A workflow reached only by the
second question is delivered no start and gets no preflight, and one reached only by the
first is delivered no waits: each role gates its own step, so a delivery buys a step only
where the subscriber row already answered that there is something for it to do.

Preflight itself is one query per arrival and no more. Its graph-and-catalog arm -- the
decode, the action and condition configs, the Lifecycle Rules -- is pure over those two, so
it is memoized per catalog on a digest of the graph, and only `validateWorkflowIntegrations`
runs per call, because the rows it reads change with no write to the workflow. The digest is
the key rather than `(id, updatedAt)` because a stale verdict carries the stale graph, which
is the object a start hands to the bus.

One Inngest listener per Event, built from the catalog in `lib/inngest/functions.ts`, so the
listener set is fixed for the life of the process and a workflow that starts on a new Event
needs no re-sync. Several Events may share one source and narrow it with `source.when`: each
listener carries that filter as its trigger's `if`, compiled by `compileEventDataEquals`, so
the bus decides which Event a payload is and a subtype nothing declared costs no invocation.
`extension-set.ts` refuses two Events on one source that both omit `when`. The handler gates
the payload again -- a host may send to the bus directly -- and then runs two sibling steps per
workflow, the Lifecycle Rules and the wait delivery, so a retry resumes at the workflow that
failed without replaying a start.

**A Wait node has two modes, and its subscription carries its own matcher.** `delay` waits
on the clock and `event` waits on an arrival. The third mode, "wait for webhook event", is
gone: it ran the same prepare and execute path as `event`, wrote the same row and suspended
on the same envelope, so the three differences it had were two defects and a field rather
than a mechanism. `waitConfigSchema` in `packages/shared/src/workflow/wait-subscription.ts`
is the first schema this node has had, both modes in one struct, and every key is
`Schema.optional` because the engine resolves templates into every declared config key and a
field left blank arrives present and holding `undefined`.

A timeout is required on an event wait, and the save rule is what requires it rather than
the key's optionality; the editor writes `7d` when the mode is first chosen. A wait without
one is an immortal Execution, holding a row, an Inngest function and a place in the run list
until somebody notices. `waitTimeoutBehavior` defaults to `continue` and is honored in both
modes.

A subscription names an Event the catalog declares, since a wait on a name nothing sends can
only time out, and carries an optional `match`, which is the serialized
`ConditionModel` the Condition node already builds, evaluated against the arriving payload
rather than against merged node outputs and so rooted at `payload`. The stored predicate is
the whole of the runtime rule, which is what keeps CONTEXT.md's "equal Entity Values, whatever
the paths" working: the editor pre-fills the match by comparing the arriving payload at that
Event's Correlation Path against the run's Entity Value, and a subscription with no match
resumes on the next occurrence of the Event. At park time the run-side values inside the
match are resolved to literals and compiled to a CEL string on the row, because a compiled
string and a literal both survive the JSONB round trip and Inngest's memoization where a
re-resolved template would not.

A match whose operands are still blank is held where the Condition node's empty expression is
held, and for the same reason: "Add a match" seeds a rule with an empty value, so refusing it
at save would refuse the editor's own default on every autosave until a builder typed one.
`ConditionCompileResult` carries `incomplete` to name that class of failure --- a blank text
box, a number field holding nothing, a timestamp with no amount or date ---
`workflow-conditions-validation.ts` skips it, and `getWaitMissingRequiredFields` in
`action-config-validation.ts` reports it, which puts the refusal in preflight and the issue on
the node in the editor. Nothing parks on it: a match comparing against the empty string wakes
on no arrival, and the run would hold until its timeout with no sentence anywhere.

The Wait node's output is what both modes leave behind (`waitType`, `timedOut`, `resumedAt`)
plus, for an event wait, the arriving Event's own payload at `payload`. `executeEventWait`
unwraps the `workflow/wait.signal` envelope `step.waitForEvent` resolves to, so a builder
writes `payload.orderId` rather than reaching through Rova's transport, and `built-ins.ts` is
where that list is declared --- the Wait is the one node with no output schema behind it.

`POST /api/workflows/waits/:token/resume` survives as a resume path and stops being a wait
mode. Every event wait gets a generated `resume_token`, since Inngest's `ifExpression`
matches on it, and the endpoint looks a wait up by that token with no event-type and no
correlation check, so a run parked on an Event that will never arrive stays unparkable
otherwise. The design-time token a builder used to write is deleted: it is decided once, the
index over it is unique, and two runs parked at the same node either collide on insert or
leave one row unfindable.

**The Lifecycle panel is the one screen that writes the rules.**
`packages/client/src/components/workflow/config/lifecycle-panel.tsx` writes the whole
`lifecycleRules` object on every edit and reads it back through `readLifecycleRules`, falling
back to `initialLifecycleRules` rather than writing on mount: opening a panel is not an edit.
That fallback carries `allowManualStart: true`, because the moment rules exist they are held to
the save rules and rules with no start source refuse the save that wrote them. The panel runs
`checkLifecycleRules` itself, over the same catalog and the same graph the server uses, so a
builder reads the refusal before a save answers with it, and it renders one Correlation Path
input per member of `eventsNeedingCorrelationPath` -- the same set the check refuses over, so a
Wait node parked on a pathless Event has an input rather than being an unsavable dead end.
Cancel Events and the schedule are present as placeholders, with no control, each rendering
the exported interim sentence a save would answer with. A schedule is not in the stored shape
at all: nothing can write one.

The entry node has no type, and no registry answers for one. `workflowTriggerConfigSchema`
is one closed struct holding `lifecycleRules` and nothing else, so a stored graph carrying
any key the panel stopped writing fails to decode, which is the strict contract this repo
keeps: `triggerType` first, which every graph saved before this batch carries, then
`routingPolicy`, `webhookEventPath`, `webhookCorrelationPath`, the `Schedule` arm's three
schedule fields, and the three that used to describe the payload by hand. The trigger
registry and the `Schedule` definition went with them.

What a downstream node may address comes from the Start Event instead.
`packages/client/src/lib/upstream-node-fields.ts` reads each named Event's `payloadFields`
off the catalog and intersects them, because a node has to cope with whichever arrival the
run reached it through: the two outlets `entryOutletsReaching` says lead to the node, and
the Cancel Events behind one of them. A path
the Events declare with different types is offered as text, which is what a template
renders it to anyway and what leaves the condition builder operators every payload can
answer. There is no hand-written shape, output contract or sample left to keep in step
with the Events.

An edge leaving the Lifecycle Node names its outlet, `started` or `canceled`, from
`shared/workflow/lifecycle-outlets.ts`: the editor's connect path writes the name and
`validateLifecycleOutletEdges` refuses an edge carrying neither, because an unnamed edge
would bind by render order. Keeping the Canceled branch terminal needs no rule of its own,
since a node the Started branch reaches already has an incoming edge and
`validateSingleIncomingEdgePerNode` allows only one.

**A cancellation is that routing and nothing else.** The flag and the canceling payload on
the execution row are the whole authority, and the engine reads them at each node boundary
inside a step keyed `lifecycle-check-${nodeId}`, so a replay takes the branch the attempt
took. That read is bought only by a graph whose Lifecycle Rules name a Cancel Event: nothing
else ever writes the flag, so a graph naming none pays neither the step nor the query, and a
Cancel Event added mid-run reaches the runs that start after it. A parked run is nudged
awake through the wait signal, which closes the wait row and decides nothing else. The
branch runs inside the same Execution, which ends with status `canceled` -- immediately so
where the outlet has no edge.

**The editor's runs panel shows what did not run.** `getExecutions` answers three things at
once, because the panel polls every two seconds and a second procedure would double that: the
runs, `supersededCount` (answered whether or not the rows were asked for, since it labels the
toggle), and the Refused Starts. Those are the `run_not_started` rows, which
`workflow-audit.ts` keeps in `WORKFLOW_SCOPED_AUDIT_EVENT_TYPES` -- the scope is what the type
means, and `NewAuditEvent` in `executions/repo/contracts.ts` requires an execution id for every
other type. A refusal is
first-wins Concurrency finding a run already going, a payload with nothing at the Correlation
Path, or a manual start the rules disallow; a paused workflow is not one of them, because that
path writes a terminal Execution and shows up in the runs list. `cancel_not_delivered` is the
other member of that list and the mirror on the cancel role: an arriving Cancel Event whose
payload carries nothing at the Correlation Path claims no run, and `deliver-event.ts` writes the
row rather than returning early, because a cancel that reached nothing is exactly as invisible
as a start that was declined.

**An Execution's statuses live in one list.** `WORKFLOW_EXECUTION_STATUSES` in
`packages/shared/src/workflow/execution-contracts.ts` is where the column's type, the RPC
literals, and the run-history filter come from, and `WORKFLOW_EXECUTION_START_SOURCES` beside
it is the `start_source` column. Terminal is `completed | canceled | superseded | failed`,
one L as CONTEXT.md has it. Three other status vocabularies keep their own words and are not
this one: a node log is `pending | running | success | error`, a wait row is
`waiting | resumed | timed_out | cancelled`, and an integration test answers
`success | error`.

**Rova's own events are defined once, with a schema.**
`packages/core/src/backend/lib/inngest/events.ts` holds the three
(`workflow/run.requested`, `workflow/run.cancel.requested`, `workflow/wait.signal`) as
`eventType()` definitions carrying their Effect schemas. Senders build payloads with
`.create(data, { id })`, where the id is Inngest's idempotency key, and functions declare
the same object as their trigger. Inngest validates on send and again before calling a
handler, so a handler receives a parsed payload and does no boundary parse of its own. A
schema violation raises `EventValidationError`, which extends `NonRetriableError`, so a
malformed run fails once rather than spending every retry on the same bad JSON. Schemas
here may not use transforms; the SDK rejects any whose input and output types differ.

**A service returns an Effect whose error channel names a domain failure, never an HTTP
status.** `packages/core/src/backend/lib/effect/failures.ts` holds one tagged error class
per kind (`invalid | unauthorized | not_found | conflict | internal`), and each carries
the payload its caller receives from a `payload` getter beside the fields it is built
from. `IntegrationValidationFailed` is the one that has more to say than a sentence: its
kind is `invalid`, and its payload carries the offending integration ids, which
`getRpcErrorMessage` appends to the message it builds and which nothing else reads today.
The two adapters at the edges translate a kind and nothing else does:
`backend/rpc/errors.ts` into an oRPC code, `backend/lib/http/failure-response.ts` into an
HTTP status.

`rpcEffectHandler` in `backend/rpc/router.ts` runs a procedure's Effect on the runtime
carried by `RpcContext`, logs a failure once, and fails with the oRPC error. `runPromise`
squashes that down to the error itself, which is the object oRPC catches. The two plain
Hono routes (event intake, wait resume) run theirs the same way and build a
`Response` from the failure.

**The backend runs on Effect.** ADR-0002 has the plan and ADR-0005 the data layer.
`database.ts` holds the `Database` service, which runs a Drizzle query and fails with a
tagged `DatabaseError`; `inngest-client.ts` holds `InngestClient`, the three sends that
drive runs, failing with a tagged `InngestError`. `internal-failure.ts` holds both
handlers that turn one of those into the logged "internal" answer a service used to write
in a `catch` block, and where a service catches decides which it takes.
`internalFailure(logger, message)` is for a body-level `Effect.catchTag`, which already
has the logger in hand. `internalFailureRelayingCause(loggerEffect, message,
callerMessage?)` is for a function-level `Effect.fn` transform, which runs outside the
generator and so takes the logger as the Effect that produces it; it hands a thrown
`Error`'s own message to the caller, and `callerMessage` is the fallback for whichever
entrypoints word their log line and their caller-facing sentence differently. This is the
shape the workflows services use. `seamFailureHandlers(loggerEffect, message,
callerMessage?)` beside them builds one relaying handler and answers both tags with it,
so a service that queries and enqueues states its policy once. `app-logger.ts` wraps the
logtape logger so a log line is an Effect. `packages/core/src/backend/runtime.ts`
composes the Layer graph, and
`createRovaApp` builds one `ManagedRuntime` from it and disposes it. The runtime is owned
by the app rather than by a module so that a service's dependencies can be replaced in a
test, which is the whole of what it buys: one Rova per process stays the only supported
arrangement, and constructing a second app in a process is undefined behavior.

A service takes its database questions from the repository service for its aggregate
(`services/api-keys/repo.ts` is the smallest worked example), never from `Database`
directly, and the type system holds it to that: `RovaServices` in `runtime.ts` leaves
`Database` out, so a service body that writes `yield* Database` needs a service the runtime
does not provide and fails to type-check where it is run. `makeDatabaseLayer(db)`, built from
the app's own handle, is provided into the repository layers instead. The repository is the seam a test stands on: hand
`stubWorkflowRepo({ findById: ... })` the one method the subject asks for, and the service
needs no database and no `vi.mock`. Those factories live in
`backend/lib/effect/test-layers.ts`, together with `SilentAppLoggerLayer` and
`makeRecordingLogger`; each fills every method a test did not name with an `Effect.die`, so
a query the test never accounted for kills it rather than reading a fake empty result. That
module is test support and ships nowhere: `packages/core` publishes `dist` and `drizzle`,
and no entry reaches it.

**Nothing reaches Inngest through module state, and one value holds all of it.**
`createInngestSurface` (`backend/lib/inngest/client.ts`) builds the client, the function
registry over it, and the `/inngest` serve handler together, because the three have to
agree: functions registered on one client and served through another are invisible to
Inngest. `createRovaApp` builds one `InngestSurface` and hands the same value to
`createRovaRuntime` and to `createApiApp`, so a divergent pair is inexpressible rather than
merely avoided. The runtime reads `client` for `makeInngestClientLayer`, which is the four
sends a service makes, and `invalidate` for `makeInngestFunctionsLayer`; `api-app.ts` names
Inngest nowhere except that one route. The registry belonging to the app is what keeps its
cached functions from outliving the runtime their event listeners close over, and a service
that changes which workflows exist drops the list through the `InngestFunctions` service --
`invalidateInngestFunctions` is that whole call, so no service body yields the service to
reach one member of it. The two helpers that mix a send with wait-state bookkeeping,
`cancelInFlightRuns` (`services/workflows/executions/end-runs.ts`) and
`resumeWaitsMatchingEvent` (`services/workflows/lifecycle/resume-waits.ts`), are Effects
over `InngestClient` and `ExecutionRepo` like any other service. `defineStep`'s call into a
handler is the one deliberate `Effect.runPromise` left outside an edge, and it goes when the
run engine comes onto Effect.

**The run engine is three ports, and the app fills all three.** `executeWorkflow` takes a
`WorkflowExecutionRuntime` for durability, a `WorkflowStore` for the run's trace, and a
`WorkflowActions` for what an action id dispatches to (`workflow-engine/actions.ts`). Every
default is the honest in-process one -- work runs inline, nothing is persisted, no action is
implemented -- so a caller that wants a node to do work injects a surface. The Inngest
adapter in `lib/inngest/workflow-function.ts` is where a live run picks up all three, and
the third comes from `createWorkflowActions`, built once per function-list rebuild from the
surface the registry read off the runtime it was handed. The engine module imports neither
the database nor the assembled surface, the same way it imports neither Inngest nor Drizzle.

The run log rows are the engine's, written through the store by
`workflow-engine/step-log.ts` around every node it runs: a plugin's action, a host's action,
the entry node, the Condition node and the Wait node all leave the same trace, and a step
author writes none of it. The Wait is the one caller that uses the two halves rather than
`runWithStepLog`, because it opens its row inside a memoized step and closes it from one of
many branches on the far side of a suspension; that whole node is
`workflow-engine/wait.ts`.

The two writes have opposite failure policies, and the split is what keeps a node's side
effect at-most-once. A refused open fails the node, and Inngest's function-level retry of it
costs one wasted call. A refused close may not, because it sits inside the node's memoized
step: a throw after the work succeeded discards the result the runtime was about to store
and re-runs the node, sending a second SMS in order to record the first. The row is left
open, which the run panel shows.

Nothing reaches the database outside a repository. The `db` proxy, `getDb`, the
two `globalThis` blocks, and the `callDbModule` / `callInngestModule` seams are all gone:
the run log, the audit rows and the wait rows are `ExecutionRepo` methods, the integration
reads are `IntegrationRepo`'s, and `createDbWorkflowStore(runtime)` in
`workflow-engine/db-store.ts` is where the engine's Promise-shaped store meets them. The
run engine still speaks Promises, so three adapters run an Effect on the app's runtime
rather than composing one: that store, the credential fetch behind `createWorkflowActions`,
and the Inngest function registry's workflow-list read.

**The database config is checked apart from the pool being opened.** `db/config.ts` holds
`DatabaseRuntimeConfig` and `normalizeDatabaseConfig`, a pure function that refuses a
config naming no database, a URL carrying its own `search_path`, and a schema name Postgres
would not read back as written. `createDatabaseSurface` in `db/index.ts` takes an already
normalized config and answers the pool and the Drizzle handle the app owns, which is what
lets `createRovaApp` refuse a bad one before it has changed anything about the process.
Nothing falls back to the environment, and where the dev database is belongs to
`scripts/migrate.ts`. The surface's `close` gives the pool back on the app's dispose path
and in a test's teardown, and with it this process's claim on the database: one Rova per
process is enforced there, so a second app naming somewhere else is refused rather than left
to open a pool beside the first. `runMigrations` takes the config and opens its own single
connection, so migrating claims nothing and a CI job, a release step and a live app may all
run it.

**Third-party libraries.** Check official usage with Context7 or Exa before writing
against a library, and never take a version from memory. Prefer latest stable, and verify
compatibility before upgrading something load-bearing. Use Base UI for UI primitives and
do not introduce Radix. Bundle size is not a concern here.

## Pitfalls that have bitten

**`vi.mock` is hoisted, and scoped to one file.** vitest lifts every `vi.mock` call above
the imports, so a factory that reads a variable declared later in the file hits the
temporal dead zone. Put that variable in `vi.hoisted`, which vitest lifts higher still.
The stub reaches only the file that declares it, because vitest resets the module registry
between test files, so a stub needs no on/off flag and the subject can be a plain static
import. For a stub that only one case in a file wants, `vi.doMock` stays where it is
written and takes effect on the next dynamic import. `vi` itself has to be imported from
`vitest`; `@effect/vitest` re-exports the name, but the copy reaching a test that way
cannot find the module registry and every `vi.mock` in the file throws at collection.

**A `Context.Reference` caches its default value forever.** The first read of a
reference with no explicit provider computes its `defaultValue` and stores it on the
reference object itself, for the life of the process. `FetchHttpClient.Fetch` defaults to
`globalThis.fetch`, so a suite that stubs the global per test would have every case after
the first running against the first case's stub. `packages/plugins/src/vendor-http.ts`
provides that reference explicitly, with a function that reads the global per call, which
is both what the old code did and what makes fetch stubbing work at all.

**Inngest shapes the workflow engine.** `step.*` inside `step.run()` is a runtime error,
so Wait nodes stay outside the node-level step wrapper. Retries are function-level, each
step carrying its own counter. Step results round-trip through JSON, so a node output has
to be JSON-safe: no `Date`, `Map`, or `Set`.

**happy-dom belongs to the client project alone.** `vitest.config.ts` declares two
projects: `client` covers `packages/client`, runs in happy-dom, and is the only one that
loads `test-setup.ts`; `node` takes every other `packages/*/src` test and runs in vitest's
node environment. That boundary is load-bearing. happy-dom ships its own `TransformStream`
whose `writable` is a boolean, and Inngest's execution engine builds a `TransformStream` on
every run, so a backend test that inherited happy-dom's globals would throw
`getWriter is not a function` the moment it touched a function. The node project's include
is the whole of `packages/*/src` with the client excluded, rather than a list of package
names, because a test file outside every project's globs is skipped without a word: a new
package's tests run from the day they are written. A test file outside `packages/` still
runs nowhere.

**There are two Vite configs and neither extends the other.**
`packages/client/vite.config.ts` is the SPA's dev server and build, owned by the package it
compiles. The root `vitest.config.ts` is the suite's, and vitest never reads the client's:
it resolves `vitest.config` first and stops at the first file it finds, so anything the
tests need is declared at the root as well. The `@rova/plugins` source aliases are shared
between them as `workspaceSourceAliases` from `scripts/plugins/workspace-source-aliases.ts`
for exactly that reason; without them a test importing `@rova/plugins` would resolve through
the package's `exports` to a stale `dist`.

**The repo has no server of its own.** The one server is the example app,
`examples/app.ts`, which is the adopter path written out and nothing more: options from the
environment, four Events and a custom action, a `node:http` mount through
`createRequestListener`. ADR-0006 has the reasoning, and the bar for a line in that file is
whether an adopter would write it.

`pnpm run dev` is three processes: the app on 4017, Vite's dev server in `packages/client`,
and the Inngest CLI. Vite serves the editor on its own port and forwards `/api` to the app
through `server.proxy`, which covers every backend route, since all of them sit under
`${basePath}/api`. Vite's default history fallback answers a page view, so nothing outside
Rova applies the SPA-path rule and no dispatch logic exists anywhere. `client` goes unset in
development, because the option takes a built bundle and development has none. `pnpm run
start` is the other arrangement and one process: the built bundle goes to `createRovaApp` as
`client`, and Rova serves the editor, the assets, and the API itself.

**Eight published entry points, across three packages.** `@rova/core` is what a host
authors vocabulary with (`defineEvent` and `createAction`), `@rova/core/app` is
`createRovaApp`, `@rova/core/node` the Node mount adapter,
`@rova/core/plugin` the names an integration package may use, and `@rova/core/migrate`
applies the migrations without building an app. `@rova/client` is the editor,
`@rova/plugins` the built-in integrations as values, and
`@rova/plugins/ui` their icons for the browser. `@rova/plugins`
peer-depends on `@rova/core`, because a second copy would mean a second database handle.
`@rova/shared` stays private and is inlined into whichever bundle needs it.

**The published package is not the dev tree.** `packages/core` has no `private` field, so
it publishes. Its `files` is scoped, and `@rova/shared` is inlined into the build so it never
appears as a dependency. `@rova/core/migrate` is there because the shipped SQL names no
schema and only Rova's migrator carries the `search_path` that decides which one it builds,
so an adopter with no Rova app running had no way to apply it; `scripts/migrate.ts` runs that
same entry, which is what keeps the repo's daily path and an adopter's CI job one code path.
There is no published server wrapper: `createRovaApp` returns a fetch handler, which
`Bun.serve` and `Deno.serve` take directly and `@rova/core/node` translates for Express and
Fastify. The one `node:http` server in the tree, `examples/app.ts`, sits outside
`packages/core` and reaches the fetch handler through `createRequestListener` from
`@rova/core/node`, which is the same translation an adopter on Node makes. Verify a
packaging change with `pnpm pack` and read the extracted manifest.

## Code cleanliness

- Remove unused imports, variables, and functions. knip reports them.
- Prefer `es-toolkit` helpers to ad-hoc chains: `omitBy(..., isNil)` to shape a payload,
  `compact(...)` over `filter(Boolean)`, `uniq(...)` and `partition(...)` over manual
  `Set` juggling.
- If an `es-toolkit` call needs an unsafe cast, write a small typed helper instead.
- Jotai by intent: `useAtom` read/write, `useAtomValue` read, `useSetAtom` write. Jotai
  holds UI state only; anything the server owns lives in the query cache.
- Server-side barrel files are allowed.
- Route handlers stay light; domain logic belongs in
  `packages/core/src/backend/services/<domain>`.
- Directory traversal represents the stack: group by domain aggregate, and let one
  directory level answer one question.

## Database

Schema is `packages/core/src/backend/lib/db/schema.ts`. Generate migrations with
`pnpm run db:generate` and apply them with `pnpm run db:migrate`. Do not hand-write migration
SQL in `packages/core/drizzle/`.

**The schema name is a runtime option, so the tables are declared unqualified.**
`database.schema` on `RovaAppOptions` names the Postgres schema Rova lives in, `_workflows`
unless a host says otherwise, and the connection's `search_path` is what puts the tables
there: `db/index.ts` sends it in the startup packet on the query client and the migration
client alike, so every connection a pool opens, and every one it reopens after a network
drop, is already pointed at it. `runMigrations` creates that schema and keeps the migration
journal inside it, so dropping the one schema removes Rova from the database. A name that is
not an unquoted lowercase identifier of at most 63 characters is refused, because
`search_path` would fold it to lowercase or Postgres would truncate it and quietly mean
something else. A `database.url` carrying a `search_path` of its own is refused too: a URL
query parameter reaches the startup packet and outranks the option, so the two would
disagree about where the tables are. A host's config reaches a pool one way only, through
`normalizeDatabaseConfig` in `db/config.ts`, which is where all of that is enforced once.

The invariant has four guards in the suite, and they are the reason this arrangement can be
trusted: `db/schema.test.ts` reads the tables off the module and holds every one to naming no
schema, `db/migrations-sql.test.ts` holds every committed statement to qualifying nothing but
Rova's own table names, `db/config.test.ts` covers the checks and the defaults the option
goes through, and `db/index.test.ts` covers what the pools are opened with and the rebinding
guard.

**Only a connection that keeps the search_path startup parameter works.** `runMigrations`
reads `current_schema()` back before applying anything and fails naming both schemas, because
a pooler silently dropping the parameter would otherwise migrate `public`. PgBouncer needs
`track_extra_parameters=search_path` (1.22+); `ignore_startup_parameters` is the wrong knob,
since it drops the value rather than passing it on. Failing that, Rova needs a session-mode
or direct connection.

**Migrations hold an advisory lock.** Postgres does not serialize concurrent `CREATE SCHEMA`
or `CREATE TABLE` of the same name, it fails the losers on a unique violation in
`pg_namespace` or `pg_type`, so replicas starting together used to crash all but the first.
The lock is session-scoped, which is why the migration pool is one connection: that is what
puts the lock and the statements it guards on the same session.

**The SQL is found by package, and the journal is append-only.** `rovaMigrationsDir` walks
up from `import.meta.url` to the manifest naming `@rova/core` and joins `drizzle` onto it,
so the answer holds in this tree and in a published `dist/` alike. Counting `..` segments
used to reach the adopter's own drizzle-kit folder in a flat `node_modules`, and Rova would
then apply their migrations on the connection carrying its search_path and its advisory
lock. Before applying anything, `assertJournalHashesAreOurs` holds every hash in
`<schema>.__drizzle_migrations` to one this build ships: drizzle decides what to run by
folder timestamp and compares no hashes, so a regenerated baseline would re-run
`CREATE TABLE` on every database that ran the old one and die on a duplicate relation. The
guard answers with the remedy instead, which is dropping the schema.
`db/migrations-sql.test.ts` pins the journal's first two entries so a regeneration is a
deliberate act rather than a side effect.

Two consequences of unqualified tables, worth knowing before touching this. First, drizzle-kit
can no longer be told where the tables are: `push` offers to drop whichever schema it was
filtered onto, and `studio` and `pull` look in `public`, so those scripts are gone and
`drizzle.config.ts` carries no credentials. Generating SQL is the one thing drizzle-kit does
offline, and `pnpm run db:migrate` (`scripts/migrate.ts`) applies it through Rova's own
migrator. That migrator is Rova's for one reason: drizzle-kit has no way to carry a
search_path except a URL query parameter, which Rova refuses for the reason above. Second,
drizzle-kit writes `REFERENCES "public"."workflows"` for a foreign key even where both tables
are unqualified, so `pnpm run db:generate` runs `scripts/unqualify-migrations.ts` after it to
take that one qualifier off. The script handles that spelling and nothing else;
`db/migrations-sql.test.ts` is what catches any other.

**`database` takes one URL or the discrete fields, and neither is rewritten into the other.**
`normalizeConnection` in `db/index.ts` checks whichever arm arrived and hands the fields to
postgres.js as fields, so a database name holding a space, an IPv6 or unix-socket host, and
`ssl` all work; folding them into a URL broke all three, because postgres.js decodes a URL's
user and password but not its path segment. The rebinding guard compares the normalized
fields one by one. The two arms are exclusive both ways: `never`-typed fields on each make a
mixed literal fail to compile, and the normalizer refuses the same mixture at runtime.

## API client

Reads and writes both go through `orpcQuery` from `#src/lib/rpc-query`: a read is
`queryOptions`, a write is `useMutation(orpcQuery.<ns>.<proc>.mutationOptions())`.
`#src/lib/rpc-client` exports the raw `rpc` client, `ApiError`, the response codecs
`toSavedWorkflow`/`toSavedWorkflows`, and `workflowApi`, which reshapes graph payloads
in both directions and exists only for the autosave queue in `workflow-save-store.ts`,
because that runs outside React. There is no `api` object and no
`#src/lib/api-client`.

A query key is derived from the contract path, so it cannot drift from
`packages/shared/src/rpc/contracts.ts`. One entry is
`orpcQuery.workflow.getById.queryKey({ input })`. Pass a `select` as a module-level
function: TanStack memoises it by identity, and an inline arrow re-runs the transform
on every render.

**Read a cache entry with `fetchQuery`, not `ensureQueryData`.** The latter returns
whatever is cached without consulting staleness or invalidation, so a read that must
reflect a write you just made is correct only while something happens to be observing
that entry.

**All six `@orpc/*` packages move together, at one exact 2.x beta.** Nothing at
install time enforces this: the 2.x packages cross-reference each other as plain
exact-version dependencies with no peer ranges, so a mismatched pair installs fine
and each brings its own nested copy. The failure is silent and lands at runtime,
because two copies mean two `ORPCError` constructors and the client's
`instanceof ORPCError` check quietly stops matching. The catalog in
`pnpm-workspace.yaml` holds all six, `@orpc/experimental-effect` among them, including
those a single workspace package imports, so one entry is the only place a version can
change. Bumping the line is
deliberate work: read the release notes first, and re-run the OpenAPI document
against the previous one, since the schema-to-JSON-Schema output moves between betas.

**A write says what it invalidates; the call site does not.** `packages/client/src/lib/rpc-query.ts`
holds `refreshWorkflowList`, `refreshRunHistory`, and `refreshIntegrations`, and they are
the only place a cache key is named for invalidation. A mutation calls one from its
`onSuccess`. Leaving that to the component that happens to mount the write is how a
deleted workflow stayed on the dashboard for a full stale window.

**Never invalidate an area key like `orpcQuery.workflow.key()`.** The area covers the
editor's `getExecutions`, `getExecutionLogs`, and `getExecutionEvents`, which poll every
two seconds while the runs panel is open, so one write becomes a burst of refetches. Each
helper takes procedure keys. `workflow.getById` is loader-owned (`router.tsx` calls
`ensureQueryData` with `staleTime: 0`) and has no observer, so nothing needs to invalidate
it and a refetch of it would be wasted.

**A mutation that shows its own failure says so.** `mutationMeta.errorShownByCaller: true`
suppresses the `MutationCache` toast for a call site that renders the error inline or in a
dialog; `errorMessage` replaces the server's wording; neither falls back to `error.message`.
`mutationErrorToast` in `query-client.ts` is that decision as a pure function, and it is
tested.

## Effects

`packages/client/src/hooks/effects.ts` is the only file in the client that may import
`useEffect` or `useLayoutEffect`; `no-restricted-imports` enforces it. Reach for one of
its named hooks, and if none of them fits, the work is very likely not an effect:
fetching belongs in a query, a derived value belongs in render, and telling a parent
something belongs in the handler that caused it.

The nine `no-effect/*` rules
(`eslint-plugin-react-you-might-not-need-an-effect`, loaded through oxlint's
`jsPlugins`) name the cases where React can do the work without an effect.

## Documentation

No emojis. Do not create new markdown docs unless asked. When you change how something
works, update the line here that describes it, and check that any path this file names
still exists.

## Agent skills

Configuration the engineering skills read before they act. Editing the files under
`docs/agents/` changes their behaviour; nothing here is enforced by lint or tests.

### Issue tracker

Issues live as GitHub issues on `alandotcom/rova`, driven by the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name.
See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, both created lazily.
See `docs/agents/domain.md`.
