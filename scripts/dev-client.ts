/**
 * The editor's Vite dev server, as `pnpm run dev` starts it. This exists to turn
 * the terminal's SIGINT into the SIGTERM Vite acts on: Vite listens for SIGTERM
 * alone, so the Ctrl+C every process in the foreground group receives kills it
 * through the default disposition, and each layer above then reports the stop
 * the user asked for as a command that failed.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// pnpm links each package's own dependencies into its node_modules/.bin, which
// is the same binary `pnpm --filter @wfgraph/client dev` would run.
const clientDirectory = fileURLToPath(
  new URL("../packages/client", import.meta.url)
);

const vite = spawn("./node_modules/.bin/vite", [], {
  cwd: clientDirectory,
  stdio: "inherit",
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    if (!vite.killed) vite.kill("SIGTERM");
  });
}

// A stop the user asked for leaves with 0, so concurrently reports an ordinary
// shutdown. A Vite that leaves on its own keeps its own status, which is what
// concurrently's --kill-others-on-fail reads.
vite.on("exit", (code, signal) => {
  process.exit(stopping ? 0 : (code ?? (signal ? 1 : 0)));
});
