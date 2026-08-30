import { defineConfig } from "vitest/config";
// Keep the `.ts`: Vite's coming native config loader is node's own, which
// guesses no extension.
import { workspaceSourceAliases } from "./scripts/plugins/workspace-source-aliases.ts";

/**
 * The test runner's own Vite config. It does not extend the client's:
 * `packages/client/vite.config.ts` configures a dev server and a build for one
 * package, while the suite spans all four, and vitest would not read it in any
 * case, because it looks for `vitest.config` first and stops at the first
 * match. Anything the tests need is declared here.
 */

// A test file outside every project's `include` is skipped in silence, so the
// node project takes everything under a package's src and carves the client out
// again, rather than naming the packages whose tests count. A new package's
// tests then run from the day they are written.
const PACKAGE_TESTS = "packages/*/src/**/*.test.{ts,tsx}";
const CLIENT_TESTS = "packages/client/src/**/*.test.{ts,tsx}";
const EVAL_SUPPORT_TESTS = "packages/evals/src/**/*.test.ts";
// The suite that wants a live PostgreSQL. A `.pg.test.ts` also ends in
// `.test.ts`, so it matches `PACKAGE_TESTS` and `CLIENT_TESTS`. The node and
// client projects both exclude it by name. Without that, one file would run
// twice: once against a database and once against a runner with none.
const POSTGRES_TESTS = "packages/*/src/**/*.pg.test.ts";
const ALWAYS_EXCLUDED = ["**/node_modules/**", "**/dist/**"];

export default defineConfig({
  resolve: {
    alias: [...workspaceSourceAliases],
  },
  test: {
    // Files share one module graph per worker. Suites that used to `vi.mock` a
    // neighbour now put a seam or `vi.spyOn` an export and restore it, so the
    // per-file isolate tax (most of CI's wall time was import) can stay off.
    isolate: false,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [PACKAGE_TESTS, EVAL_SUPPORT_TESTS],
          exclude: [...ALWAYS_EXCLUDED, CLIENT_TESTS, POSTGRES_TESTS],
        },
      },
      {
        extends: true,
        test: {
          // The one project that wants a service. Every case skips itself when
          // `WFGRAPH_TEST_DATABASE_URL` names no server. That is the case for a
          // developer who has not run `docker compose up -d` and for the
          // `checks` job in `pr-checks.yml`. The postgres job there is the one
          // place the URL is set.
          name: "postgres",
          environment: "node",
          include: [POSTGRES_TESTS],
          exclude: ALWAYS_EXCLUDED,
          // The URL may sit in a gitignored `.env.local` the way
          // `INTEGRATION_ENCRYPTION_KEY` does, and Node reads no `.env` unless
          // an entrypoint asks it to. `vitest.evals.config.ts` loads it for the
          // same reason.
          setupFiles: ["./load-env.ts"],
          // Cases drop their own schema, so the sweep only finds what an
          // interrupted run left. It runs at setup rather than teardown, so a
          // failing run's schema stays put for whoever wants to look at it.
          // The entry sits in `scripts/` so it can load the `.env` files first.
          // `globalSetup` runs in the main process before any worker, so the
          // `setupFiles` entry has not run yet. A URL that lives only in
          // `.env.local` would otherwise leave the sweep skipping without a
          // word.
          globalSetup: ["./scripts/postgres-test-schemas.ts"],
          // A case mints a schema, migrates it and drops it again. The default
          // of `5000` ms is one cold container away from being exceeded, and a
          // timeout there reads as a failing test rather than a slow service.
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // Correctness does not rest on this setting, because every case owns
          // a schema. What it bounds is connections: each file holds pools, and
          // a wide fan-out reaches the server's default 100 long before it
          // would reach a faster suite.
          fileParallelism: false,
          // The root turns isolation off to pay import cost once per worker,
          // which pays off across a suite of thousands of tests. These few
          // files each hold a pool, so this project keeps isolation on.
          isolate: true,
        },
      },
      {
        extends: true,
        test: {
          name: "client",
          // Only the client renders components, so only the client pays for a
          // DOM. The backend packages run bare, which is what an embedder's
          // process looks like.
          environment: "happy-dom",
          include: [CLIENT_TESTS],
          exclude: [...ALWAYS_EXCLUDED, POSTGRES_TESTS],
          setupFiles: ["./test-setup.ts"],
          server: {
            deps: {
              // bundle.test.ts imports the built @wfgraph/client to check where
              // `clientBundle.dir` lands, and that answer comes from the built
              // file's own `import.meta.url`. The module runner rewrites that,
              // so this one artifact goes to node's loader untouched.
              external: [/packages\/client\/dist\//],
            },
          },
        },
      },
    ],
  },
});
