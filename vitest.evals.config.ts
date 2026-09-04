import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "./scripts/plugins/workspace-source-aliases.ts";

/**
 * A file name no run overwrites, so two runs can be compared.
 *
 * `WFGRAPH_EVAL_LABEL` names what the run was measuring, matching the other two
 * knobs this suite reads from the environment, `WFGRAPH_EVAL_AGENT_MODEL` and
 * `WFGRAPH_EVAL_REASONING_EFFORT`. `vitest-evals serve eval-results` reads the
 * whole directory, which is the point of keeping each one.
 */
function reportPath(): string {
  const [date, time] = new Date().toISOString().split("T");
  const stamp = `${date?.replaceAll("-", "")}-${time?.slice(0, 8).replaceAll(":", "")}`;
  const label = process.env.WFGRAPH_EVAL_LABEL?.trim() || "run";
  return `eval-results/${stamp}-${label}.json`;
}

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
    // Info rather than the reporter's compact default: it prints per-tool
    // summaries, arguments and the final output, which is what makes a failing
    // run readable without opening the report UI.
    reporters: [["vitest-evals/reporter", { reportLevel: "info" }], "json"],
    outputFile: { json: reportPath() },
    // Scenarios keep their own graph, trace, and cancellation state. Running a
    // small batch concurrently reduces model wait time without a large burst.
    sequence: { concurrent: true },
    maxConcurrency: 4,
  },
});
