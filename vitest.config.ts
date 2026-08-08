import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "./scripts/plugins/workspace-source-aliases";

/**
 * The test runner's own Vite config. It does not extend the client's:
 * `packages/client/vite.config.ts` configures a dev server and a build for one
 * package, while the suite spans all four, and vitest would not read it in any
 * case, since it looks for `vitest.config` first and stops at the first match.
 * Anything the tests need is declared here.
 */

// A test file outside every project's `include` is skipped in silence, so the
// node project takes everything under a package's src and carves the client out
// again, rather than naming the packages whose tests count. A new package's
// tests then run from the day they are written.
const PACKAGE_TESTS = "packages/*/src/**/*.test.{ts,tsx}";
const CLIENT_TESTS = "packages/client/src/**/*.test.{ts,tsx}";
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
          include: [PACKAGE_TESTS],
          exclude: [...ALWAYS_EXCLUDED, CLIENT_TESTS],
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
          exclude: ALWAYS_EXCLUDED,
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
