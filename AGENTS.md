# Agent Instructions

Workflow Graph: a pnpm workspace monorepo with six packages under `packages/`,
beside `@wfgraph/example-app` (`examples/`), the host app `pnpm run dev` runs.

- `@wfgraph/shared` (`packages/shared`) runtime-agnostic types, workflow contracts, utilities
- `@wfgraph/agent` (`packages/agent`) the build agent's tools, toolkit and system prompt.
  Private and unbuilt like `@wfgraph/shared`, and inlined into core. It depends on
  `@wfgraph/shared` and `effect` alone, so a tool is testable with no model, no HTTP
  and no database
- `@wfgraph/evals` (`packages/evals`) the private Vitest Evals harness, judges and
  scenarios for the build agent. `pnpm run evals` runs it manually against a live model;
  it is neither built nor published
- `@wfgraph/core` (`packages/core`) library entrypoints and the backend
- `@wfgraph/client` (`packages/client`) the React SPA, handed to `createWfGraphApp` as `client`
- `@wfgraph/plugins` (`packages/plugins`) the five built-in integrations. Each server half
  builds against `@wfgraph/core/plugin` alone; the browser half is one exported record,
  `src/ui.ts`, which the editor provides through React context.

Read the code for structure. `README.md` is the short host entrypoint, `docs/embedding.md`,
`docs/events.md`, and `docs/integrations.md` hold the host manuals, `CONTEXT.md` the domain
vocabulary, `docs/adr/` the decisions. What follows is what none of those say.

## Package management

pnpm only, at the version the root `packageManager` field names (`corepack enable` gets
it). Never npm, yarn, or `bun install`. Node runs everything, and `engines` names Node 24
as the floor. Trying Workflow Graph inside another app is `pnpm link <path-to>/packages/core` after
a build, since the published entries point at `dist`.

**`#src/` means this package's own `src`, never another's.** It is a Node subpath import,
defined against the manifest of the file that wrote it, so it cannot leave the package.
Import a sibling by name: `@wfgraph/shared/types/json`, `@wfgraph/core/plugin`. ESM resolution
has no directory-index and no extension guessing, so write `#src/backend/lib/db/index`.
Inside `packages/core/src`, `#src/` is the only spelling a lint rule allows.

**Every pnpm setting lives in `pnpm-workspace.yaml`**, including the catalog that holds
any version two packages share. `allowBuilds` needs a verdict for each dependency
shipping an install script, or the install ends with `ERR_PNPM_IGNORED_BUILDS`.

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

## Releasing

A change that alters what an adopter installs needs a changeset. Run
`pnpm exec changeset`, pick a bump, and commit the `.changeset/*.md` file with the code.
A change nothing outside the repo can observe takes `pnpm exec changeset --empty` or no
changeset at all.

**The four packages share one version.** `.changeset/config.json` names `core`, `client`,
`plugins` and `shared` as a `fixed` group, so a changeset naming any one of them releases
all four at the same number. That is what keeps the editor bundle in `@wfgraph/client` from
being installed against a `@wfgraph/core` whose oRPC contract it no longer matches, and it
is why a `@wfgraph/shared` change reaches the registry at all: shared is inlined into the
other three at build time and is declared only as their devDependency, which on its own
would bump nothing.

`@wfgraph/shared` is private, so it is versioned for the lockstep and never published.
`@wfgraph/evals` and `@wfgraph/example-app` are in `ignore`, so they stay at 0.0.0.

**Each published manifest keeps its `devDependencies`, including `@wfgraph/shared` at a
version no registry serves. Leave it there.** The three packages import that source, so
deleting the line to tidy the tarball reports 135 unlisted dependencies from knip and makes
the repo lie about what it reads. It is inert once published, because a resolver reads only
the `dependencies`, `peerDependencies` and `optionalDependencies` of a package it installs.

`onlyUpdatePeerDependentsWhenOutOfRange` is on because `@wfgraph/plugins` names
`@wfgraph/core` as a peer dependency. Left off, changesets reads every minor bump of core as
a breaking change for its peer dependents, and the fixed group would carry the whole repo to
a major. The peer range stays `*` for the same reason; the fixed group is what actually
holds the two versions together.

**`.github/workflows/release.yml`'s filename is part of the npm credential.** Each of the
three packages has a trusted publisher on npmjs.com naming this repository and that exact
filename, and publishing is OIDC only, with no token anywhere. Renaming the file makes every
publish fail with a 404 until the three npm settings pages are changed to match.

**The release runs as four jobs, and the split is the security boundary.** `select-mode`
reads the repo and answers version, publish or none. `version` opens the release PR and holds
`contents: write` with no npm credential. `pack` runs `pnpm run build` and packs the
tarballs, which makes it the job executing tsdown, Vite and every install script in the tree,
so it is given no write permission and no token. `publish` uploads the tarballs `pack`
produced, runs no build, and is the only job holding `id-token: write`. Collapsing these back
into the single `changesets/action@v2` would hand the OIDC token to the same job that runs
the build; changesets recommends the split for exactly that reason. `actions/setup-node` must
stay without a `registry-url` in the publish job, since that option writes an `_authToken`
placeholder pnpm would send in place of the OIDC-issued token.

**The action and the CLI move together.** `changesets/action@v2` refuses to run against
Changesets CLI v2 and says so, and `changesets/action@v1` is the pairing for the older CLI.
v2 also stopped reading `GITHUB_TOKEN` for its own auth, taking a `github-token` input that
defaults to the workflow token, which leaves the `GITHUB_TOKEN` in the version job's `env`
there for `@changesets/changelog-github` alone.

Publishing a package npm has never seen cannot use OIDC, because a trusted publisher is
configured on a package that already exists. The first version of a new `@wfgraph/*` package
goes out by hand with `npm login` and `pnpm run release:publish`, and its trusted publisher
is added afterwards. That script is the local path only: CI never calls it, because the
`pack` and `publish` jobs split the build from the upload that script runs together.

## Conventions that differ from the defaults

**No backwards compatibility.** There is no stored data and no external consumer. Make the
stricter contract strict and let the old shape fail. A test encoding the old permissiveness
was asserting a bug. **Actions are the exception:** evolve an action forward-compatibly under
the same id (additive keys and output paths only; see `docs/integrations.md`), or ship a new
id and set `hidden: true` on the old one so the picker drops it while runs keep working.

**JSON has a type; use it.** `packages/shared/src/types/json.ts` holds `JsonValue` and
`JsonObject`. Anything walking a value that arrived as JSON takes one of them, and narrowing
is then plain language checks rather than a `value is Record<string, unknown>` predicate.

**Effect Schema is the only schema library** inside `packages/`, and
`packages/shared/src/types/schema.ts` holds the three names most of the repo needs:
`NonEmptyTrimmedString`, `rejectUnknownKeys`, and `toStandardSchema`. Four rules that cost
something to learn:

- Strictness is a decode option. Effect has no `.strict()`, so a wire decode passes
  `rejectUnknownKeys`; a shape meant to stay open says so with `Schema.StructWithRest`.
- `toStandardSchema` bakes those options in, and a schema crosses that bridge once. The
  first crossing decides its options for good.
- `Schema.optionalKey` for a shape read from JSON, `Schema.optional` for one built in
  process, and under a canonical JSON codec the two swap places. All three cases are worked
  in `packages/core/src/backend/extensions/steps/define-step.test.ts`.
- Annotate the base type before any check, or the annotation lands on the check and a
  wrong-typed value never reaches it. `packages/shared/src/conditions/condition-schema.ts` is the
  worked example.

**A message never quotes the value it rejected.** Render a decode failure a person will read
with `formatSchemaFailure` (`packages/shared/src/types/schema-message.ts`), since these
strings are persisted as run errors and answered over HTTP. Effect keeps the rejected input
out of its own messages unless a decode passes `reportInput`, and no decode here passes it,
so what this adds is length: a union that matched nothing is named by its kind, and the
issues past the third are counted.

**Timestamps cross through a codec.** `packages/shared/src/types/timestamp.ts` owns the one
ISO-string-to-`Date` conversion, and `isoTimestampString` is the spelling that also carries
`format: "date-time"`, which `schema-codec` reads to set `type: "timestamp"` on the flat
`ReferenceField` the editor menus off.

**Zod is the example app's schema library, and a test fixture inside `packages/`.**
`@wfgraph/example-app` is written in it, which makes "an adopter needs no Effect" enforceable
rather than promised. In `packages/` it is a devDependency of `core` and `shared` only.

**The authoring vocabulary is three functions**, all in
`packages/core/src/backend/extensions/` and walked through in `docs/events.md` and
`docs/integrations.md`: `defineEvent` and `defineAction` for a host, `defineIntegration`
for an integration. Nothing registers on import. An integration's actions are object
literals inside that one call, and `defineStep` is the internal builder each is mapped
through, reachable from no entry. `docs/integrations.md` owns the canonical JSON codec
contract a step boundary runs both directions through; `steps/define-step.ts`'s header
states the invariant in brief.

**The extension surface is one JSON catalog, served on one route** (ADR-0008). A test that
needs one provides `stubExtensions` or `stubExtensionCatalog` from
`backend/lib/effect/test-layers.ts`.

**The Lifecycle Rules are per workflow** (CONTEXT.md for the vocabulary, ADR-0007 for why),
in `packages/shared/src/lifecycle/lifecycle-rules.ts` with the fan-out beside it in
`services/workflows/lifecycle/`. A Wait node subscribes independently of them, and
`lifecycle/wait-subscription.ts` holds both its modes with every key `Schema.optional`, since the
engine resolves templates into every declared config key and a blank field arrives holding
`undefined`. Build every CEL literal with `celStringLiteral`
(`packages/shared/src/conditions/cel-string-literal.ts`): hand-rolling the escape is how a
value carrying a newline gets past a test and fails at Inngest, where the failure is a run
that never triggers.

**A service returns an Effect whose error channel names a domain failure, never an HTTP
status.** `backend/lib/effect/failures.ts` holds one tagged class per kind
(`invalid | unauthorized | not_found | conflict | internal`), and two adapters translate a
kind: `backend/rpc/errors.ts` into an oRPC code, `backend/lib/http/failure-response.ts` into
an HTTP status.

**A service takes its database questions from its aggregate's repository**, never from
`Database` directly, and the type system holds it to that: `WfGraphServices` in
`backend/runtime.ts` leaves `Database` out, so a body writing `yield* Database` fails to
type-check where it is run. The repository is the seam a test stands on, through the
factories in `backend/lib/effect/test-layers.ts`; each fills every unnamed method with an
`Effect.die`, so an unaccounted query kills the test rather than reading a fake empty
result. ADR-0002 has the Effect plan, ADR-0005 the data layer.

**The run engine is three ports and speaks Effect.** `executeWorkflow` (`backend/engine/`)
takes a durability runtime, an Effect-native store for the run's trace, and a
`WorkflowActions` for what an action id dispatches to; `lib/inngest/workflow-function.ts`
fills all three and runs the resulting Effect on the app runtime. The engine imports neither
the database, the assembled surface, Inngest, nor Drizzle.

**The host configures logtape, and a record is one unit of work** (ADR-0013).
`backend/lib/logger.ts` is `getAppLogger` and the `wfgraph` root, and it calls no
`configure`. Configuration lives in two places a host reaches on purpose: the published
`@wfgraph/core/logging` entry (`configureWfGraphLogging`), and `backend/lib/log-config.ts`
(`configureLoggingWithBridge` for the `logger` option, plus the one-time notice
`warnWhenLoggingUnconfigured` prints when neither was used). `backend/lib/pretty-formatter.ts`
holds the console layout and is the one module `src/logging.ts` may import for it: it reaches
`node:util`, and the Worker bundle reaches `log-config.ts` and would carry that with it.

Two rules for a call site. Write one record per unit of work, and put the fields on it
rather than narrating the steps that produced it; `engine/scheduler.ts`'s `logNode` is the
worked example, and the run's two records in `engine/core.ts` are the other. Group a record's own
fields by subject (`http`, `rpc`, `run`, `node`, `outcome`, `error`) rather than flat,
because the pretty layout prints a line per top-level field and holds a group to that one
line while its `key=value` pairs fit `LOG_PRETTY_WIDTH`; a JSON line carries the group as a
nested object a store addresses as `run.execution`. A single correlation key carried by
`logger.with({ workflowId })` stays flat, since it is one line and grouping it would be
replaced by any record annotating the same key. A category is one level deep under
`wfgraph`, since it sits ahead of the message on every header line.

**Never log a payload.** A request body, a response body, a step output and an Event
payload are each stored where they can be read whole, and one of them printed at
`inspect` depth buries the fifty lines around it. Name its size or its keys.

**Third-party libraries.** Check official usage with Context7 or Exa before writing against
a library, and never take a version from memory. Prefer latest stable. Use Base UI for UI
primitives and do not introduce Radix. Bundle size is not a concern here.

The one Radix in the tree arrives under `@assistant-ui/react`, which the build agent's
chat panel is built on. Its own widget-level Radix sits in primitives this repo does not
import (`assistantModal`, `actionBarMore`, `threadListItemMore`, `dropdownMenuRenderPrimitives`).
What we write stays Base UI: the panel composes assistant-ui's headless primitives with
`components/ui/button` and the rest of `components/ui`, which is also what the registry's
own Base UI flavour at `r.assistant-ui.com/base/*` does.

## Pitfalls that have bitten

**`vi.mock` is hoisted, and shares the worker's module graph.** vitest lifts every
`vi.mock` call above the imports, so a factory reading a variable declared later in
the file hits the temporal dead zone. Put that variable in `vi.hoisted`, which vitest
lifts higher still. The suite runs with `isolate: false`, so a mock that replaces a
module stays in that worker's evaluated graph for later files. Prefer:

- catalog-as-argument on pure helpers, and `ExtensionCatalogProvider` /
  `useExtensionCatalog()` for React (fixtures wrap the provider; only
  `extensions.test.ts` stubs `fetch` to exercise hydrate)
- required DI ports at construction (`runEventListener`'s `deliver`,
  `WorkflowFunctionPorts.execute*`, `createInngestSurface`'s `connect`)
- injected SDK factories (`createLinear(createClient)`) rather than `vi.spyOn` of
  thin wrappers
- fetch stubs that read `globalThis` per call (see `RPCLink`'s `fetch`)

Do not add production put/dial seams written only for tests. For a stub only one
case wants, `vi.doMock` stays where it is written and takes effect on the next
dynamic import. Import `vi` from `vitest`: `@effect/vitest` re-exports the name, but
the copy reaching a test that way cannot find the module registry, and every `vi.mock`
in the file then throws at collection.

**A `Context.Reference` caches its default value forever.** The first read of a reference
with no explicit provider computes its `defaultValue` and stores it on the reference object
itself, for the life of the process. `FetchHttpClient.Fetch` defaults to `globalThis.fetch`,
so a suite stubbing the global per test would have every case after the first running
against the first case's stub. `ExternalTransport`
(`packages/core/src/backend/extensions/steps/external-transport.ts`) provides that reference
explicitly, with a function reading the global per call, which is what makes fetch stubbing
work at all.

**Inngest shapes the workflow engine.** `step.*` inside `step.run()` is a runtime error, so
a Wait node suspends outside any step. Workflow Graph wraps no handler body (ADR-0009): work with a
side effect goes in the handler's own `step.run`, and a `StepFailure` travels back as a
value so a refused call fails the node once rather than four times. Retries are
function-level, each step carrying its own counter. Step results round-trip through JSON, and
`JsonSafe` (`packages/shared/src/types/json.ts`) is the compiler holding `step.run` to it: a
`Date`, `Map` or `Set` in the answer is refused at the field that holds it.

**An Inngest suspension abandons the parked Effect invocation.** A Layer on the app's
`ManagedRuntime` outlives every run, so it must never hold the per-invocation action surface
or credentials. Finalizers above a suspension do not run, and a fork there leaks; keep
end-of-run work as an explicit durable call and do not use `Effect.fork` in the engine. A
timeout or race around `runtime.run`, `sleep`, `waitForEvent`, or `startBranch` turns
Inngest's intentionally unsettled Promise into a failure, so those calls get neither.

**A suspension holds the run, and a branch is given a run.** Inngest parks a whole function
invocation on a sleep and wakes it once, at the last of its outstanding pauses, so each
waiting branch is a durable run of its own (ADR-0011). `NodeScheduler` holds every Wait back
and `drainDeferredWaits` hands it to `workflow-branch` through `runtime.startBranch`, which
is `step.invoke`. The branch run inherits the outputs above its entry node from the store and
its released node ids from the invoke payload, and leaves the terminal record to the run that
started it. A cancellation kills it where it stands; that run observes the kill, sweeps the
rows it left open, and routes the Execution. A runtime offering no `startBranch` enters the
Wait in place. `driveWithReplay` (`engine/testing/replay-runtime.ts`) is how a test sees any of this:
it owns a set of runs and keeps the measured wake policy per run.

**happy-dom belongs to the client project alone.** `vitest.config.ts` declares two projects:
`client` covers `packages/client`, runs in happy-dom, and is the only one loading
`test-setup.ts`; `node` takes every other `packages/*/src` test and runs bare. That boundary
is load-bearing. happy-dom ships its own `TransformStream` whose `writable` is a boolean,
and Inngest's execution engine builds a `TransformStream` on every run, so a backend test
inheriting happy-dom's globals would throw `getWriter is not a function` the moment it
touched a function. The node project's include is the whole of `packages/*/src` with the
client carved out, rather than a list of package names, because a test file outside every
project's globs is skipped without a word. A test file outside `packages/` still runs
nowhere.

**There are two Vite configs and neither extends the other.**
`packages/client/vite.config.ts` is the SPA's dev server and build; the root
`vitest.config.ts` is the suite's. vitest resolves `vitest.config` first and stops at the
first file it finds, so anything the tests need is declared at the root as well. The
`@wfgraph/plugins` source aliases are shared between them as `workspaceSourceAliases`
(`scripts/plugins/workspace-source-aliases.ts`) for that reason; without them a test
importing `@wfgraph/plugins` would resolve through the package's `exports` to a stale `dist`.

**The repo has no server of its own.** The one server is `examples/app.ts` (ADR-0006), and
the bar for a line in it is whether an adopter would write it. `pnpm run dev` is three
processes: the app on 4017, Vite's dev server in `packages/client`, and the Inngest CLI.
Vite serves the editor on its own port and proxies `/api`, and its history fallback answers
a page view, so nothing outside Workflow Graph applies the SPA-path rule. `client` goes unset in
development, because the option takes a built bundle. `pnpm run start` is one process, with
the built bundle handed to `createWfGraphApp`.

**The published package is not the dev tree.** `packages/core` publishes `dist` and
`drizzle`, with `@wfgraph/shared` inlined into the build so it never appears as a dependency,
and `backend/lib/effect/test-layers.ts` reachable from no entry. Verify a packaging change
with `pnpm pack` and read the extracted manifest. `docs/embedding.md` ("Package exports")
is the one home of the seven core entry points.

## Code cleanliness

- Remove unused imports, variables, and functions. knip reports them.
- Prefer `es-toolkit` helpers to ad-hoc chains: `omitBy(..., isNil)` to shape a payload,
  `compact(...)` over `filter(Boolean)`, `uniq(...)` and `partition(...)` over manual
  `Set` juggling. If a call needs an unsafe cast, write a small typed helper instead.
- Jotai by intent: `useAtom` read/write, `useAtomValue` read, `useSetAtom` write. Jotai
  holds UI state only; anything the server owns lives in the query cache.
- Server-side barrel files are allowed.
- Route handlers stay light; domain logic belongs in
  `packages/core/src/backend/services/<domain>`.
- Directory traversal represents the stack: group by domain aggregate, and let one
  directory level answer one question.

## Persistence and database

`createWfGraphApp` takes an opaque `persistence` backend. The application
runtime sees only the four aggregate repository services; backend-specific
connection, schema, migration, query, and concurrency code stays under
`backend/persistence/`. `@wfgraph/core/postgres` is the long-lived Node
PostgreSQL backend, `@wfgraph/core/sqlite` is native Node SQLite, and
`@wfgraph/core/worker` opens PostgreSQL through Hyperdrive per request. A new
backend implements the repository contracts rather than adding a database
handle to `WfGraphServices`.

Schema is `packages/core/src/backend/lib/db/schema.ts`, on PostgreSQL 15 or newer.
Generate migrations with `pnpm run db:generate` and apply them with `pnpm run db:migrate`.
Do not hand-write migration SQL in `packages/core/drizzle/`.
Those two scripts want a PostgreSQL on port `55437`, which `docker compose up -d` gives
from `docker-compose.yml`; the example app runs on SQLite and needs neither.
The schema file itself must not import through `#src/`: drizzle-kit's loader resolves
the package `imports` map to `.js` paths and cannot find the TypeScript sources, so
anything the schema needs from Workflow Graph lands in `@wfgraph/shared` (as the audit
event type literals do).

The tables are declared unqualified and the connection's `search_path` decides which
Postgres schema they live in, which is a runtime option. That arrangement, what it refuses,
and the four tests guarding it are ADR-0005's amendment. The journal is append-only:
`assertJournalHashesAreOurs` holds every hash to one this build ships, because a
rebaselined migration set either fails drizzle's journal-name upgrade or re-runs
`CREATE TABLE` on every database that ran the old one.

SQLite owns its separate normalized schema and migrates it on open. Its write
transaction is `BEGIN IMMEDIATE`; do not split a repository decision into
separate read and write transactions. The Worker/Hyperdrive backend requires
query caching disabled and verifies that the origin role's default
`search_path` resolves to the configured schema. PostgreSQL migrations for a
Worker deployment run out of band through `@wfgraph/core/migrate`.

## API client

Reads and writes both go through `orpcQuery` from `#src/lib/rpc-query`: a read is
`queryOptions`, a write is `useMutation(orpcQuery.<ns>.<proc>.mutationOptions())`.
`#src/lib/rpc-client` exports the raw `rpc` client, `ApiError`, the response codec
`toSavedWorkflow`, and `workflowApi`, which exists only for the autosave queue in
`workflow-save-store.ts`, because that runs outside React.

**One procedure streams, and it is the agent's.** `agent.chat` declares an
`eventIterator` output, so its handler is an async generator and `RPCLink` hands the
browser an async iterable. `rpcStreamHandler` in `backend/rpc/router.ts` is the seam,
beside `rpcEffectHandler`. A failure raised while building the stream becomes an oRPC
error; a failure once it is running cannot, because the response has already begun, so
the stream carries its own bad news as an `error` part.

A query key is derived from the contract path, so it cannot drift from
`packages/shared/src/rpc/contracts.ts`. Pass a `select` as a module-level function: TanStack
memoises it by identity, and an inline arrow re-runs the transform on every render. Read a
cache entry with `fetchQuery`: `ensureQueryData` returns whatever is cached without
consulting staleness, so a read that must reflect a write you just made is correct only
while something happens to be observing that entry.

**All six `@orpc/*` packages move together, at one exact 2.x beta**, which is why the
catalog holds all six. They cross-reference each other as exact-version dependencies with no
peer ranges, so a mismatched pair installs fine and each brings its own nested copy. The
failure is silent and lands at runtime, because two copies mean two `ORPCError` constructors
and the client's `instanceof` check quietly stops matching.

**A write says what it invalidates; the call site does not.** `refreshWorkflowList`,
`refreshRunHistory` and `refreshIntegrations` in `packages/client/src/lib/rpc-query.ts` are
the only place a cache key is named for invalidation, and a mutation calls one from its
`onSuccess`. **Never invalidate an area key** like `orpcQuery.workflow.key()`: the area
covers the run panel's three procedures, which poll every two seconds, so one write becomes
a burst of refetches.

**A write can also patch instead of invalidate, in the one place that names the entry.**
`cacheWorkflowPublication` (`packages/client/src/lib/rpc-query.ts`) writes the publish
badge's fields straight into the open workflow's `getById` entry with `setQueryData`, for a
mutation whose own response already carries the fresher value: invalidating would only
refetch what the mutation just returned. This is the one place that patches a cache entry
directly; every other write invalidates through the helpers above.

**A mutation that shows its own failure says so.** `mutationMeta.errorShownByCaller: true`
suppresses the `MutationCache` toast for a call site rendering the error itself;
`errorMessage` replaces the server's wording; neither falls back to `error.message`.
`mutationErrorToast` in `query-client.ts` is that decision as a pure function.

## Effects

`packages/client/src/hooks/effects.ts` is the only file in the client that may import
`useEffect` or `useLayoutEffect`; `no-restricted-imports` enforces it. Reach for one of its
named hooks, and if none fits, the work is very likely not an effect: fetching belongs in a
query, a derived value belongs in render, and telling a parent something belongs in the
handler that caused it. The nine `no-effect/*` rules name the cases React can do without one.

## Documentation

No emojis. Do not create new markdown docs unless asked.

**One fact, one home.** Before writing a sentence, find whose it is:

- **CONTEXT.md** owns domain vocabulary, one paragraph per term.
- **An ADR** owns why a design was chosen: once, in past tense, never updated. A decision
  that changes gets a dated amendment, not a rewrite.
- **README.md** owns the short entrypoint: what Workflow Graph is, how to run it locally, and a
  minimal embed. Detail lives under `docs/`: `docs/embedding.md` (mount, database,
  options, package exports), `docs/events.md` (`defineEvent`), `docs/integrations.md`
  (`defineIntegration`).
- **AGENTS.md** owns what an agent must know that no other file says.
- **A module header** owns the contract a caller cannot read off the signature (units,
  nullability, call order, failure modes). At most five lines, and it never repeats a
  sentence from AGENTS.md.
- **`packages/client/PRODUCT.md` and `DESIGN.md`** own the editor's product and design
  vocabulary.

When you change how something works, update the one line that describes it. Every path and
every backticked identifier in this file must exist in the tree; a sentence naming
machinery that greps to nothing costs a future session an hour.

## Agent skills

Configuration the engineering skills read before they act. Editing these changes their
behaviour; nothing in them is enforced by lint or tests.

- `docs/agents/issue-tracker.md` — issues are GitHub issues on `alandotcom/wfgraph`, via `gh`.
- `docs/agents/triage-labels.md` — the five triage roles, each label equal to its name.
- `docs/agents/domain.md` — single-context: one `CONTEXT.md` and `docs/adr/` at the root.

## Cursor Cloud specific instructions

### Runtime services

`pnpm run dev` starts the three processes (example app `:4017`, Vite client `:5173`, and the Inngest CLI on four ports `scripts/dev.ts` reserves at startup and prints, so a second checkout never collides; `INNGEST_DEV_PORT` pins the UI one). The example stores its data in SQLite at gitignored `examples/wfgraph.sqlite`, which it creates and migrates on open, so there is no service to start and no migration to apply. The update script only refreshes deps (`pnpm install`); it never runs `pnpm run dev`, so each session must start the services.

The app refuses to start without `INTEGRATION_ENCRYPTION_KEY` (64-char hex). Put it in gitignored `.env.local` at the repo root.

### Cloud VM gotchas

- **Node 24 is required** (`engines` / `.node-version`). nvm's default alias is set to 24, so a normal `bash` shell already resolves the nvm Node 24 binary and its corepack `pnpm` (verify with `node -v`). If a stray older Node (e.g. `/exec-daemon/node`) is ever ahead on `PATH`, put nvm first: `export PATH="$HOME/.nvm/versions/node/$(nvm version 24)/bin:$PATH"`.
- For driving a real workflow against Inngest (not vitest), use `.claude/skills/live-run/SKILL.md`.
