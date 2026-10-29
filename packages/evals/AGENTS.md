# Eval instructions

The eval layer is `src/eval/`: `describeEval` binds a harness and its judges to a Vitest
suite, `EvalReporter` prints each case after the run, and `task.meta.eval` is the record
both read. A gating judge fails a case below 1; an advisory judge is only recorded.
Deterministic support tests (`*.test.ts`) run in the root suite's `node` project through
`pnpm run test`; model-backed evals (`*.eval.ts`) run only through `pnpm run evals`.

Before reporting that `OPENAI_API_KEY` is unavailable, check both `.env.local`
and `.env` at the repository root. The eval configuration loads those files
through `load-env.ts`, with `.env.local` taking precedence. Do not infer key
availability from the current shell environment, and never print the key.

When `OPENAI_API_KEY` is configured in either file, run the requested
model-backed evals. Do not commit the generated reports under `eval-results/`.

Filter a run with `pnpm run evals -t "<name>"`, and never with `pnpm run evals --
-t "<name>"`. The `--` reaches vitest ahead of the pattern, which then selects
nothing and the whole suite runs. Every scenario title is truncated in the test
name, so match a prefix rather than a phrase from the middle. `WFGRAPH_EVAL_LABEL`
names the report the run writes, beside `WFGRAPH_EVAL_AGENT_MODEL` and
`WFGRAPH_EVAL_REASONING_EFFORT`.
