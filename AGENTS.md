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
  those same options because an index signature skips the excess-property check.
- **`toStandardSchema` is where those options are baked in**, because oRPC and Inngest call
  `~standard.validate(payload)` with nothing else to say. Effect assigns `~standard` onto
  the schema and returns early if a `validate` is already there, so a schema crosses that
  bridge once and the first crossing decides its options. The RPC contracts and the Inngest
  event types call it directly for that reason. The trigger and action registries call it
  themselves, at registration, so `createTrigger` and `createAction` take a bare
  `Schema.Struct` and an integration author writes no bridging ceremony; `Schema.isSchema`
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
used by `trigger-registry.test.ts`, `action-registry.test.ts`, and
`standard-schema-compat.test.ts` as the foreign Standard Schema library those registries
claim to accept, beside arktype. Nothing at runtime imports it and no published manifest
names it. Do not reach for it in new code.

**Timestamps cross through a codec.** `packages/shared/src/types/timestamp.ts` owns the
one ISO-string-to-`Date` conversion, as a checked `Schema.decodeTo` pair. Do not hand-roll `new Date(x)` or
`.toISOString()` for a value crossing the wire.

**A step is written with `defineStep`.** `packages/core/src/backend/lib/steps/define-step.ts`
takes an input schema, an output schema, and a handler returning an
`Effect<Output, StepFailure, HttpClient>`, and owns everything around it: the config
decode, the credential fetch, the run log rows, and the `StepResult` envelope
(`{ success: true, data }` or `{ success: false, error: { message } }`, in
`packages/shared/src/workflow/step-result.ts`) that the engine reads. A handler never
writes that envelope and never touches a Promise. Every plugin step is one of these,
registered with `registerStep` under the id it declares. `Database Query` and
`HTTP Request`, the two the engine ships itself, are the exception: each answers a shape
the envelope has no room for, so they stay Promise functions behind a registration that
`step-registry.ts` keeps to itself.

**An action's output fields come from its output schema.** A plugin action declares
`output` in its `index.ts`, and `registerIntegration` derives the editor's
template-autocomplete paths from it (`packages/shared/src/workflow/output-fields.ts`).
Paths omit the `data.` prefix, because the schema describes the payload rather than the
wrapper; template variables unwrap it automatically. The schema lives in the plugin's
`schemas.ts` so that the step and the metadata are typed against the same constant, and
`output` is required: there is no hand-written list to declare instead, and a schema the
derivation cannot read throws at registration naming the action.

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
Hono routes (webhook intake, wait-hook resume) run theirs the same way and build a
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
environment, a custom trigger and action, a `node:http` mount through
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

**Four published surfaces.** `@rova/core` is the backend, `@rova/core/plugin` the names an
integration package may use, `@rova/client` the editor, `@rova/plugins` the
built-in integrations. `@rova/plugins` peer-depends on `@rova/core`, because a second
copy would mean a second database handle. `@rova/shared` stays private and is inlined
into whichever bundle needs it.

**The published package is not the dev tree.** `packages/core` has no `private` field, so
it publishes. Its `files` is scoped, `@rova/shared` is inlined into the build so it never appears as a dependency,
and there is no published server wrapper: `createRovaApp` returns a fetch handler, which
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
`pnpm run db:generate` and apply them with `pnpm run db:push`. Do not hand-write migration
SQL in `packages/core/drizzle/`.

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
