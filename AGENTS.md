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

**`@/` means this package's own `src`, never another's.** An alias resolves to a
file, so the resolver never reads a manifest for it and an undeclared cross-package
dependency stays invisible. Import a sibling by name: `@rova/shared/types/json`,
`@rova/core/plugin`. Lint rejects the alias forms.

**Every pnpm setting lives in `pnpm-workspace.yaml`.** pnpm reads no `pnpm` field
from `package.json` and reads only auth and registry settings from `.npmrc`, so the
workspace globs, the catalog, `overrides` and `allowBuilds` are all in that one file.
`allowBuilds` lists each dependency that ships an install script with a true or false
verdict; a dependency that gains a script and is missing from the list ends the install
with `ERR_PNPM_IGNORED_BUILDS`.

**Shared versions live in the pnpm catalog** in `pnpm-workspace.yaml`. When a dependency
is used by two or more packages, put the version there and reference it as `"catalog:"`.
`pnpm publish` and `pnpm pack` rewrite those to real semver, so a published package is
unaffected.

## Required checks before finishing

```bash
pnpm run type-check   # tsc --noEmit, TypeScript 7
pnpm run lint         # oxlint --type-aware, prints nothing when clean
pnpm run test         # vitest, one project per environment
pnpm run build        # library via tsdown, then the client
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
boundary with Zod, so the interior holds typed values.

**Timestamps cross through a codec.** `packages/shared/src/types/timestamp.ts` owns the
one ISO-string-to-`Date` conversion, as a `z.codec`. Do not hand-roll `new Date(x)` or
`.toISOString()` for a value crossing the wire.

**Steps return `StepResult`.** `{ success: true, data }` or
`{ success: false, error: { message } }`, defined in
`packages/shared/src/workflow/step-result.ts`. The type enforces it, so a step that
answers any other shape fails to compile. `outputFields` in a plugin's `index.ts` omits
the `data.` prefix; template variables unwrap the wrapper automatically.

**Rova's own events are defined once, with a schema.**
`packages/core/src/backend/lib/inngest/events.ts` holds the three
(`workflow/run.requested`, `workflow/run.cancel.requested`, `workflow/wait.signal`) as
`eventType()` definitions carrying their Zod schemas. Senders build payloads with
`.create(data, { id })`, where the id is Inngest's idempotency key, and functions declare
the same object as their trigger. Inngest validates on send and again before calling a
handler, so a handler receives a parsed payload and does no boundary parse of its own. A
schema violation raises `EventValidationError`, which extends `NonRetriableError`, so a
malformed run fails once rather than spending every retry on the same bad JSON. Schemas
here may not use transforms; the SDK rejects any whose input and output types differ.

**Services return a domain failure kind, not an HTTP status.**
`packages/core/src/backend/lib/service-result.ts` defines
`invalid | unauthorized | not_found | conflict | internal`. The adapters at the edges
translate; nothing inside the backend names a status code.

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
written and takes effect on the next dynamic import.

**Inngest shapes the workflow engine.** `step.*` inside `step.run()` is a runtime error,
so Wait nodes stay outside the node-level step wrapper. Retries are function-level, each
step carrying its own counter. Step results round-trip through JSON, so a node output has
to be JSON-safe: no `Date`, `Map`, or `Set`.

**happy-dom belongs to the client project alone.** `vitest.config.ts` declares two
projects: `node` covers `packages/{shared,core,plugins}` and runs in vitest's node
environment, and `client` covers `packages/client`, runs in happy-dom, and is the only
one that loads `test-setup.ts`. That boundary is load-bearing. happy-dom ships its own
`TransformStream` whose `writable` is a boolean, and Inngest's execution engine builds a
`TransformStream` on every run, so a backend test that inherited happy-dom's globals
would throw `getWriter is not a function` the moment it touched a function. Keep a
backend test file under one of the three node-project paths.

**Development needs no client build.** `server.ts` creates Vite in middleware mode inside
its own process, so `dev:app` is one process on port 4017 and Vite compiles the SPA per
request. `client` goes unset there, because the option takes a built bundle and development
has none: the SPA paths are dispatched to Vite before `rova.fetch` sees them, and everything
Vite does not recognise falls through to it. Production is the other arrangement, and
`pnpm run start` runs it: the built bundle goes to `createRovaApp` as `client`, Rova applies
the same SPA rule itself, and `server.ts` routes nothing.

**Four published surfaces.** `@rova/core` is the backend, `@rova/core/plugin` the five
names an integration package may use, `@rova/client` the editor, `@rova/plugins` the
built-in integrations. `@rova/plugins` peer-depends on `@rova/core`, because a second
copy would mean a second database handle. `@rova/shared` stays private and is inlined
into whichever bundle needs it.

**The published package is not the dev tree.** `packages/core` has no `private` field, so
it publishes. Its `files` is scoped, `@rova/shared` is inlined into the build so it never appears as a dependency,
and there is no published server wrapper: `createRovaApp` returns a fetch handler, which
`Bun.serve` and `Deno.serve` take directly and `@rova/core/node` translates for Express and
Fastify. The two `node:http` servers in the tree, at `server.ts` and in
`examples/library-trigger.ts`, both sit outside `packages/core` and both reach the fetch
handler through `createRequestListener` from `@rova/core/node`, which is the same
translation an adopter on Node makes. Verify a packaging change with `pnpm pack` and read
the extracted manifest.

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

## Database

Schema is `packages/core/src/backend/lib/db/schema.ts`. Generate migrations with
`pnpm run db:generate` and apply them with `pnpm run db:push`. Do not hand-write migration
SQL in `packages/core/drizzle/`.

## API client

Reads and writes both go through `orpcQuery` from `@/lib/rpc-query`: a read is
`queryOptions`, a write is `useMutation(orpcQuery.<ns>.<proc>.mutationOptions())`.
`@/lib/rpc-client` exports the raw `rpc` client, `ApiError`, the response codecs
`toSavedWorkflow`/`toSavedWorkflows`, and `workflowApi`, which reshapes graph payloads
in both directions and exists only for the autosave queue in `workflow-save-store.ts`,
because that runs outside React. There is no `api` object and no `@/lib/api-client`.

A query key is derived from the contract path, so it cannot drift from
`packages/shared/src/rpc/contracts.ts`. One entry is
`orpcQuery.workflow.getById.queryKey({ input })`. Pass a `select` as a module-level
function: TanStack memoises it by identity, and an inline arrow re-runs the transform
on every render.

**Read a cache entry with `fetchQuery`, not `ensureQueryData`.** The latter returns
whatever is cached without consulting staleness or invalidation, so a read that must
reflect a write you just made is correct only while something happens to be observing
that entry.

`@orpc/tanstack-query` pins its `@orpc/client` peer to an exact version, so all six
`@orpc/*` packages move together.

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
