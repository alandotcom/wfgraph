# Agent Instructions

Rova Workflow Builder: a Bun workspace monorepo with four packages under `packages/`.

- `@rova/shared` (`packages/shared`) runtime-agnostic types, workflow contracts, utilities
- `@rova/core` (`packages/core`) library entrypoints and the backend
- `@rova/client` (`packages/client`) the React SPA, handed to `createRovaApp` as `client`
- `@rova/plugins` (`packages/plugins`) integration plugins and their steps

Read the code for structure. What follows is what the code cannot tell you.

## Package management

Bun only. `bun add <pkg>`, `bun run <script>`. Never npm or yarn.

**Isolated linking is on** (`bunfig.toml` sets `linker = "isolated"`). A package may
only import what its own `package.json` declares, so the dependency belongs on the
package that imports it. The guarantee covers npm specifiers; a
cross-package import through a `@/` path alias sidesteps it, so do not reach into
another package's source.

**Shared versions live in a Bun catalog** in the root `package.json`. When a dependency
is used by two or more packages, put the version there and reference it as `"catalog:"`.
`bun publish` and `bun pm pack` rewrite those to real semver, so a published package is
unaffected.

## Required checks before finishing

```bash
bun run type-check   # tsc --noEmit, TypeScript 7
bun run lint         # oxlint --type-aware, prints nothing when clean
bun test             # bun:test
bun run build        # library via tsdown, then the client
bun run knip         # unused files, exports, dependencies
bun run fix          # oxfmt, must leave the tree clean
```

Do not leave the repo with a failing check. `bun run lint` printing nothing means it
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

**Services return a domain failure kind, not an HTTP status.**
`packages/core/src/backend/lib/service-result.ts` defines
`invalid | unauthorized | not_found | conflict | internal`. The adapters at the edges
translate; nothing inside the backend names a status code.

**Third-party libraries.** Check official usage with Context7 or Exa before writing
against a library, and never take a version from memory. Prefer latest stable, and verify
compatibility before upgrading something load-bearing. Use Base UI for UI primitives and
do not introduce Radix. Bundle size is not a concern here.

## Pitfalls that have bitten

**`mock.module` is process-wide in Bun.** A test file that stubs a module affects every
other test file in the run. Gate a stub behind a flag set in `beforeAll`/`afterAll`, and
bind the real function eagerly, because a module namespace is a live view and reading it
after the mock recurses forever.

**Inngest shapes the workflow engine.** `step.*` inside `step.run()` is a runtime error,
so Wait nodes stay outside the node-level step wrapper. Retries are function-level, each
step carrying its own counter. Step results round-trip through JSON, so a node output has
to be JSON-safe: no `Date`, `Map`, or `Set`.

**Development needs no client build.** The repo's own `server.ts` hands Bun's HTML
entrypoint to `Bun.serve`'s `routes`, which Bun transpiles per request, so the SPA paths
never reach `rova.fetch` and `client` goes unset there. Serving the client source directory
as static files hands the browser TypeScript instead.

**The published package is not the dev tree.** `packages/core` has no `private` field, so
it publishes. Its `files` is scoped, `@rova/shared` is inlined into the build so it never appears as a dependency,
and there is no published server wrapper: `createRovaApp` returns a fetch handler, which
`Bun.serve` and `Deno.serve` take directly and `@rova/core/node` translates for Express and
Fastify. The two `Bun.serve` calls in the tree, at `server.ts` and in
`examples/library-trigger.ts`, both sit outside `packages/core`. Verify a packaging change
with `bun pm pack` and read the extracted manifest.

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
`bun run db:generate` and apply them with `bun run db:push`. Do not hand-write migration
SQL in `packages/core/drizzle/`.

## API client

Import the typed RPC client as `import { api } from "@/lib/rpc-client"`. There is no
`@/lib/api-client`.

Reads go through TanStack Query, not through `api` directly.
`packages/client/src/lib/rpc-query.ts` wraps the contract with
`@orpc/tanstack-query`, so a query key is derived from the contract path and cannot
drift from `packages/shared/src/rpc/contracts.ts`. Invalidate an area with
`orpcQuery.integration.key()`, one entry with
`orpcQuery.workflow.getById.queryKey({ input })`. Pass a `select` as a module-level
function: TanStack memoises it by identity, and an inline arrow re-runs the transform
on every render.

`@orpc/tanstack-query` pins its `@orpc/client` peer to an exact version, so all six
`@orpc/*` packages move together.

**Never invalidate `orpcQuery.workflow.key()` from the editor.** Any non-status patch
queues a save, so a broad invalidation would refetch the workflow, rehydrate the graph,
re-run the integration repair, and save again, discarding whatever the user typed while
the request was in flight. The editor invalidates `workflow.getAll.key()` and nothing
wider.

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
