import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "./scripts/plugins/workspace-source-aliases.ts";

/** Model-backed evals run separately from the deterministic unit-test projects. */
export default defineConfig({
  resolve: {
    alias: [...workspaceSourceAliases],
  },
  test: {
    environment: "node",
    include: ["packages/evals/src/**/*.eval.ts"],
    setupFiles: ["./load-env.ts"],
    testTimeout: 180_000,
    hookTimeout: 30_000,
    maxConcurrency: 1,
  },
});
