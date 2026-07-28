/**
 * Puts the repo's .env files into process.env before anything else runs.
 *
 * Bun read them on its own, so the server never had to say so. Node reads
 * nothing, and importing this module is the earliest a plain TypeScript
 * entrypoint can act: ES module imports are evaluated in source order, so
 * naming this one first means the variables are in place before @rova/core
 * loads and reads them.
 *
 * `.env.local` wins over `.env`, and a variable the shell already set wins over
 * both. That last rule is what lets `dev:app` pin NODE_ENV and INNGEST_DEV on
 * the command line.
 */

import { config as loadDotEnv } from "dotenv";

loadDotEnv({ path: [".env.local", ".env"], quiet: true });
