/**
 * What `pnpm run dev` runs: the example app and the editor's Vite dev server,
 * side by side under concurrently. The app's port is `PORT` (4017 by default),
 * which is what packages/client's Vite config reads to point its `/api` proxy,
 * and the app runs workflows and delivers Events in its own worker loop, so
 * nothing else has to be running.
 */

import { spawn } from "node:child_process";

const child = spawn(
  "pnpm",
  [
    "exec",
    "concurrently",
    "--kill-others-on-fail",
    "--names",
    "app,client",
    "--prefix-colors",
    "blue,green",
    "pnpm run dev:app",
    // Vite runs through scripts/dev-client.ts, whose header says what a plain
    // `pnpm --filter @wfgraph/client dev` does to Ctrl+C.
    "tsx scripts/dev-client.ts",
  ],
  { stdio: "inherit" }
);

// concurrently stops its own children on a signal, so this only has to pass the
// signal down and then leave with whatever it reports.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
