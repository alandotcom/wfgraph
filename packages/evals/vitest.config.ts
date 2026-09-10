import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../../scripts/plugins/workspace-source-aliases.ts";

/** Deterministic support tests use the Vitest version required by vitest-evals. */
export default defineConfig({
  resolve: {
    alias: [...workspaceSourceAliases],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    isolate: false,
  },
});
