import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "./scripts/plugins/workspace-source-aliases.ts";

/** Real application, database and Inngest instances; no shared DOM or fake clock. */
export default defineConfig({
  resolve: { alias: [...workspaceSourceAliases] },
  test: {
    name: "reliability",
    environment: "node",
    // Injected repository failures make the SDK log retry errors on successful runs.
    // Keep those diagnostics visible when a property actually fails.
    silent: "passed-only",
    include: [
      "packages/core/src/backend/testing/reliability/**/*.reliability.test.ts",
    ],
    // Each family owns its ports, Inngest state, and database storage.
    // Keep scenarios sequential inside each isolated worker process.
    pool: "forks",
    fileParallelism: true,
    maxWorkers: 3,
    isolate: true,
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
