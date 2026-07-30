# Agent Instructions

Rova Workflow Builder: a pnpm workspace monorepo with four packages under `packages/`.

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

**Zod is a test fixture, nothing more.** It is a devDependency of `packages/shared` alone,
used by `action-registry.test.ts` and `standard-schema-compat.test.ts` as the foreign
Standard Schema library `createAction` claims to accept, beside arktype. Nothing at runtime
imports it and no published manifest names it. Do not reach for it in new code.

**Timestamps cross through a codec.** `packages/shared/src/types/timestamp.ts` owns the
one ISO-string-to-`Date` conversion, as a checked `Schema.decodeTo` pair. Do not hand-roll `new Date(x)` or
`.toISOString()` for a value crossing the wire.

The same module holds the two spellings a schema author writes for a datetime field, both
re-exported from `@rova/core` and `@rova/core/plugin`: `timestampField(description)` is an
ISO string on both sides, and `dateField(description)` is that string on the wire with a
`Date` in a handler. Either one carries `format: "date-time"` on the encoded side, which is
the whole of how the editor learns a field is a moment in time -- it is what gives the field
before/after operators in the condition builder, and what ranks it to the top of the menu at
a field asking for a date. `Schema.Date` is refused at registration: a declaration has no
encoding chain to annotate, so its description never reaches the JSON Schema the derivation
reads.

The keyword is the only route, and a foreign library takes it too: arktype writes it as
`type("string.date.iso").configure({ format: "date-time" })`, and Zod's `z.iso.datetime()`
emits it already. A pattern alone says nothing, whatever the regex looks like.

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
config decode, the credential fetch, the run log rows, and the `StepResult` envelope
(`{ success: true, data }` or `{ success: false, error: { message } }`, in
`packages/shared/src/workflow/step-result.ts`) that the engine reads. A handler never
writes that envelope and never touches a Promise. Each `configFields[].key` is
`Extract<keyof TInput, string>`, so a field the step cannot read fails to compile.

The handler's `context` parameter is typed with the open credential record unless an
author annotates it, and that is deliberate: a type parameter appearing only inside a
context-sensitive argument cannot be inferred before that argument is typed, so inferring
the credential vocabulary there would cost an inline handler both parameter types and
leave the whole handler unchecked.

**A handler either sits inline or arrives through `load`.** Exactly one of `handler` and
`load` is written, and a value carrying both fails to compile. `load` is a loader for the
handler's own module, and it exists for two reasons that the built-ins show: a module that
imports a vendor SDK (`@clerk/backend`, `@linear/sdk`, `@fountain-bio/acuity`) stays out of
a process that never runs one of its actions, and an integration with eight actions is not
a file anybody reads. The schemas stay in the definition, exported for the handler's module
to type itself against, which is why those four plugins export theirs and slack and twilio
do not.

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

`Database Query` and `HTTP Request`, the two the engine ships itself, are the exception to
all of this: each answers a shape the envelope has no room for, so they stay Promise
functions behind a registration that `step-registry.ts` keeps to itself.

**An action's output fields come from its output schema.** An action declares `output` on
its `defineStep`, and assembly derives the editor's template-autocomplete paths from it
(`packages/shared/src/workflow/output-fields.ts`).
Paths omit the `data.` prefix, because the schema describes the payload rather than the
wrapper; template variables unwrap it automatically. The schema sits beside the handler it
types, and `output` is required: there is no hand-written list to declare instead, and a
schema the derivation cannot read throws naming the offender.
`requireOutputFieldsFromSchema` takes
that name as a phrase rather than an id, because an Event's payload schema comes through
it too and the message has to say which kind of thing is at fault.

A host action spells the same thing `outputSchema` on its `createAction`, and derives its
fields there rather than at assembly, because that call is where any Standard Schema library
is bridged. The two differ in one way worth knowing before reading `runtime.ts`: only a
`defineStep` action encodes its answer through the output schema. A `createAction` validates
its input and hands `execute`'s answer back as it is, so what its output schema buys is the
handler's return type and the field list, and the dev-mode JSON-safety walk in
`workflow-engine/runtime.ts` is still what guards it, as it guards the two built-in steps.
Stage 7 item 5 is what retires that walk.

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
(`packages/core/src/backend/lib/extensions/extension-set.ts`) and hands it to
`configureExtensions`, whose module state stage 7 replaces with a service. Assembly is
where a definition mistake is caught, naming the offender: each of an Event's name, an
action's id and an integration's type is held to one owner, an output schema the
derivation cannot read is refused naming the action, and so is a required config key with
no field for a builder to fill in. It is also where an integration definition's actions
get their ids and their derived field lists, and where `stepFor` and `connectionTestFor`
come from, since a definition carries both. The four actions the engine ships itself are
catalog entries in `built-ins.ts`, beside the `database` integration one of them runs
against, and a host's own actions arrive as `extensions.actions` -- `createAction` values,
which carry their `execute` into the same `stepFor`, so dispatch has one kind of thing to
find.

The server reads that catalog for everything it used to ask a registry: the credential
mapping in `credential-fetcher.ts`, the secret-key test in
`integration-config-masking.ts`, the action labels and step dispatch in
`step-registry.ts`, and both workflow validators. Each asks `getExtensions()`, which
throws, because every one of them sits inside an app and a surface that was never
assembled is a mistake rather than an empty answer: a lenient lookup would have a run
dispatch nothing, a save pass every check, and a config serve its secrets unmasked. A test
of one of those stands a surface up, which `configureTestExtensions` in
`backend/lib/effect/test-layers.ts` does in a line, and an empty assembly still carries the
built-in four.

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
Which Events start a run and which cancel it is the Workflow Builder's per-workflow
declaration, never the Event's (ADR-0007).

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
survived them), `concurrency.ts` is `startWithConcurrency`, `intake.ts` is
`POST /api/events/:eventName`, and `subscriptions.ts` derives the
`workflow_event_subscriptions` rows a graph calls for, each carrying the builder's
Correlation Path override for its Event so a delivery never reads a graph to find one. Those
rows are written by `WorkflowRepo` in the same transaction as the graph, and the fan-out
re-reads a workflow's rules before acting, so a row that outlives the role it was written for
costs a wasted read and nothing else.

`listEventSubscribers` asks two questions per arrival: which workflows name this Event as a
start in the graph they hold now, from that index, and which runs are still parked on it, from
`workflow_wait_states.subscribed_events` -- the names the row was written with, so an edit to
the Wait node cannot orphan the runs already parked on it. A workflow reached only by the
second question is delivered no start and gets no preflight.

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

A subscription names an Event and carries an optional `match`, which is the serialized
`ConditionModel` the Condition node already builds, evaluated against the arriving payload
rather than against merged node outputs and so rooted at `payload`. The stored predicate is
the whole of the runtime rule, which is what keeps CONTEXT.md's "equal Entity Values, whatever
the paths" working: the editor pre-fills the match by comparing the arriving payload at that
Event's Correlation Path against the run's Entity Value, and a subscription with no match
resumes on the next occurrence of the Event. At park time the run-side values inside the
match are resolved to literals and compiled to a CEL string on the row, because a compiled
string and a literal both survive the JSONB round trip and Inngest's memoization where a
re-resolved template would not.

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

What a downstream node may address comes from the Start Events instead.
`packages/client/src/lib/upstream-node-fields.ts` reads each named Event's `payloadFields`
off the catalog and intersects them, because a node has to cope with whichever start the
run arrived through, and one intersection covers both sources of multiplicity: several
Start Events, and the two outlets `entryOutletsReaching` says can reach the node. A path
the Events declare with different types is offered as text, which is what a template
renders it to anyway and what leaves the condition builder operators every payload can
answer. There is no hand-written shape, output contract or sample left to keep in step
with the Events.

An edge leaving the Lifecycle Node names its outlet, `started`, from
`shared/workflow/lifecycle-outlets.ts`: the editor's connect path writes it and
`validateLifecycleOutletEdges` refuses an edge without it, because the Canceled outlet lands
in stage 7 and an unnamed edge would then bind by render order.

**The editor's runs panel shows what did not run.** `getExecutions` answers three things at
once, because the panel polls every two seconds and a second procedure would double that: the
runs, `supersededCount` (answered whether or not the rows were asked for, since it labels the
toggle), and the Refused Starts. Those are the `run_not_started` rows, which
`workflow-audit.ts` keeps in `WORKFLOW_SCOPED_AUDIT_EVENT_TYPES` -- the scope is what the type
means, and `logWorkflowAuditEvent` requires an execution id for every other type. A refusal is
first-wins Concurrency finding a run already going, a payload with nothing at the Correlation
Path, or a manual start the rules disallow; a paused workflow is not one of them, because that
path writes a terminal Execution and shows up in the runs list.

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
does not provide and fails to type-check where it is run. `DatabaseLayer` is provided into
the repository layers instead. The repository is the seam a test stands on: hand
`stubWorkflowRepo({ findById: ... })` the one method the subject asks for, and the service
needs no database and no `vi.mock`. Those factories live in
`backend/lib/effect/test-layers.ts`, together with `SilentAppLoggerLayer` and
`makeRecordingLogger`; each fills every method a test did not name with an `Effect.die`, so
a query the test never accounted for kills it rather than reading a fake empty result. That
module is test support and ships nowhere: `packages/core` publishes `dist` and `drizzle`,
and no entry reaches it.

The run engine has not moved yet. The `db` proxy, `getDb`, and the process-global Inngest
client survive because the workflow function's step store, the step logger, the credential
fetcher, and the function registry all read them from outside any runtime; stage 7 owns
their deletion. `callDbModule` and `callInngestModule` are the seams a service crosses to
reach a `backend/lib` module that still speaks Promises, each giving it the tagged error
channel its own queries have.

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
authors vocabulary with (`defineEvent`, `createAction`, `timestampField`, `dateField`),
`@rova/core/app` is `createRovaApp`, `@rova/core/node` the Node mount adapter,
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
disagree about where the tables are. Every config source, the `DATABASE_URL` and
`DATABASE_SCHEMA` fallbacks included, goes through `normalizeRuntimeConfig`, which is where
all of that is enforced once.

The invariant has three guards in the suite, and they are the reason this arrangement can be
trusted: `db/schema.test.ts` reads the tables off the module and holds every one to naming no
schema, `db/migrations-sql.test.ts` holds every committed statement to qualifying nothing but
Rova's own table names, and `db/index.test.ts` covers the option and the environment path.

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
