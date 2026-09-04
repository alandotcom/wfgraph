# Eval instructions

Before reporting that `OPENAI_API_KEY` is unavailable, check both `.env.local`
and `.env` at the repository root. The eval configuration loads those files
through `load-env.ts`, with `.env.local` taking precedence. Do not infer key
availability from the current shell environment, and never print the key.

When `OPENAI_API_KEY` is configured in either file, run the requested
model-backed evals. Do not commit the generated `vitest-results.json` file.
