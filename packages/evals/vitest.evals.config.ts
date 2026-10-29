import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "../../scripts/plugins/workspace-source-aliases.ts";
import { EvalReporter } from "./src/eval/reporter.ts";

const repositoryFile = (path: string) =>
  fileURLToPath(new URL(`../../${path}`, import.meta.url));

/**
 * A file name no run overwrites, so two runs can be compared.
 *
 * `WFGRAPH_EVAL_LABEL` names what the run was measuring, matching the other two
 * knobs this suite reads from the environment, `WFGRAPH_EVAL_AGENT_MODEL` and
 * `WFGRAPH_EVAL_REASONING_EFFORT`. Each case's scores, transcript, usage and
 * artifacts are in its `meta.eval`.
 */
function reportPath(): string {
  const [date, time] = new Date().toISOString().split("T");
  const stamp = `${date?.replaceAll("-", "")}-${time?.slice(0, 8).replaceAll(":", "")}`;
  const label = process.env.WFGRAPH_EVAL_LABEL?.trim() || "run";
  return repositoryFile(`eval-results/${stamp}-${label}.json`);
}

/** Model-backed evals run separately from the deterministic unit-test projects. */
export default defineConfig({
  resolve: {
    alias: [...workspaceSourceAliases],
  },
  test: {
    environment: "node",
    include: ["src/**/*.eval.ts"],
    setupFiles: [repositoryFile("load-env.ts")],
    testTimeout: 180_000,
    hookTimeout: 30_000,
    // The eval reporter prints each case's judge scores, usage, tool activity
    // and final reply after Vitest's own summary, which is what makes a failing
    // run readable without opening the JSON report.
    reporters: ["default", new EvalReporter(), "json"],
    outputFile: { json: reportPath() },
    // Scenarios keep their own graph, trace, and cancellation state. Running a
    // small batch concurrently reduces model wait time without a large burst.
    sequence: { concurrent: true },
    maxConcurrency: 4,
  },
});
