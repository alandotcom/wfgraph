# Leave Bun for Node, pnpm, Vite, and vitest

_Decided 2026-07-27 by Alan Cohen, following an architecture review._

WfGraph is a Bun workspace monorepo: Bun is the runtime, the package manager, the test runner
via `bun:test`, and the client dev server via `Bun.serve`'s HTML entrypoint. Embedders,
though, run the published `@wfgraph/core` on Node, so the tests that guard this code have
always executed on a different runtime than the code they guard. Adopting Effect
(ADR-0002) brings `@effect/vitest`, which requires vitest, and that forced the question.

We are leaving the Bun platform completely:

- **Node 24** is the runtime, for development and for production.
- **pnpm workspaces** replace Bun workspaces. pnpm catalogs take over from the Bun catalog
  in the root `package.json`, and pnpm's default isolated `node_modules` gives the same
  guarantee that `bunfig.toml`'s `linker = "isolated"` gives today, so a package can still
  import only what its own `package.json` declares.
- **Vite** serves and builds `@wfgraph/client`, taking over from the per-request
  transpilation that `Bun.serve` does for the HTML entrypoint in `server.ts`.
- **vitest with `@effect/vitest`** is the only test runner, replacing `bun:test`.

This supersedes an earlier decision that rejected Vite in this repo. That decision rested
on Bun being the runtime and providing the dev-time transpilation itself, and the premise
is gone.

## Considered Options

- **vitest for tests, Bun kept as runtime and package manager** rejected: it ends the
  runtime divergence for tests while leaving the toolchain split across two platforms, and
  the day-to-day cost of that split is what we set out to remove.
- **Node as the runtime, Bun kept as the package manager** rejected for the same reason.
  Half a platform is still a second platform to reason about, and the resolution
  behaviour of the linker would then govern a tree that Node executes.

## Consequences

- The two `Bun.serve` call sites, `server.ts` and `examples/library-trigger.ts`, are
  rewritten. The dev server becomes Vite's, and the example runs through `@wfgraph/core/node`.
  _2026-07-28: superseded by ADR-0006. Neither file exists; the repo has one server, the
  example app at `examples/app.ts`._
- Development gains a client build step in the sense that Vite now owns transpilation. The
  AGENTS.md note explaining why `client` goes unset in development is replaced by whatever
  Vite's dev middleware arrangement turns out to be.
- Every `bun run <script>` in documentation and CI becomes `pnpm`, and packaging is
  verified with `pnpm pack` rather than `bun pm pack`.
- `test-setup.ts` moves to vitest's setup-file contract, and module stubbing moves to
  `vi.mock`. Whether the process-wide leakage documented in AGENTS.md for Bun's
  `mock.module` still applies has to be checked against vitest's isolation settings before
  the existing `beforeAll`/`afterAll` guards are removed.
- Bun's speed on installs and test runs is given up. This is the price of one platform.
