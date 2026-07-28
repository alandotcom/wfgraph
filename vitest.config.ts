import { defineConfig } from "vitest/config";
import {
  packageScopedAlias,
  workspaceSourceAliases,
} from "./scripts/plugins/package-scoped-alias";

/**
 * This file replaces vite.config.ts for the test runner rather than extending
 * it. vitest looks for `vitest.config` before `vite.config` and stops at the
 * first match, so anything the tests need has to be declared here as well.
 */

// A test file outside every project's `include` is skipped in silence, so the
// node project takes everything under a package's src and carves the client out
// again, rather than naming the packages whose tests count. A new package's
// tests then run from the day they are written.
const PACKAGE_TESTS = "packages/*/src/**/*.test.{ts,tsx}";
const CLIENT_TESTS = "packages/client/src/**/*.test.{ts,tsx}";
const ALWAYS_EXCLUDED = ["**/node_modules/**", "**/dist/**"];

export default defineConfig({
  plugins: [packageScopedAlias()],
  resolve: {
    alias: [...workspaceSourceAliases],
  },
  test: {
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
              // bundle.test.ts imports the built @rova/client to check where
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
