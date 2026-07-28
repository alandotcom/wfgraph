/**
 * Puts the repo's .env files into process.env before anything else runs.
 *
 * Node leaves .env files alone unless the process was started with a flag
 * naming one, so an entrypoint that wants them has to load them itself.
 * Importing this module is the earliest a plain TypeScript entrypoint can act:
 * ES module imports are evaluated in source order, so naming this one first
 * means the variables are in place before @rova/core loads and reads them.
 *
 * `.env.local` wins over `.env`, and a variable the shell already set wins over
 * both. That last rule is what lets `pnpm run dev` pin NODE_ENV, HOST, and
 * INNGEST_BASE_URL on the command line.
 */

import { config as loadDotEnv } from "dotenv";

loadDotEnv({ path: [".env.local", ".env"], quiet: true });
