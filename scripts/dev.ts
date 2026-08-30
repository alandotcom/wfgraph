/**
 * What `pnpm run dev` runs. It reserves the ports the Inngest Dev Server needs,
 * puts them in the environment, and then starts the three dev processes.
 *
 * The ports are picked at startup rather than written down, because the Inngest
 * CLI's fixed defaults are the one thing here that collides: a second checkout,
 * a git worktree, or another project's Inngest already holding 8288 stops this
 * repo's dev loop with a bind error. Every port is still overridable, so
 * `INNGEST_DEV_PORT=8388 pnpm run dev` pins the UI where a bookmark expects it.
 *
 * The dependency runs one way. The example app dials out to the connect gateway,
 * so the CLI never needs the app's port, and the app learns the two it needs
 * from `INNGEST_BASE_URL` and `INNGEST_CONNECT_GATEWAY_URL` below. The app's own
 * port stays `PORT` (4017 by default), which is what packages/client's Vite
 * config already reads to point its `/api` proxy.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";

/**
 * Reserve `count` distinct free ports. Every server stays open until the last
 * port is known, because closing one before asking for the next lets the OS
 * hand the same number out twice.
 *
 * Between this returning and the CLI binding, nothing holds the ports. That
 * window is why an explicit override exists at all.
 */
async function reserveFreePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const server = createServer();
          server.unref();
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve(server));
        })
    )
  );

  const ports = servers.map((server) => {
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("dev: a reserved socket reported no port");
    }
    return address.port;
  });

  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );

  return ports;
}

// The four ports the Inngest CLI binds, each holding an override an operator can
// set. An unset one is filled from the reserved pool in order.
const PORT_VARIABLES = [
  "INNGEST_DEV_PORT",
  "INNGEST_CONNECT_GATEWAY_PORT",
  "INNGEST_CONNECT_GATEWAY_GRPC_PORT",
  "INNGEST_CONNECT_EXECUTOR_GRPC_PORT",
] as const;

const overrides = PORT_VARIABLES.map(
  (name) => process.env[name]?.trim() || undefined
);
const reserved = await reserveFreePorts(
  overrides.filter((value) => !value).length
);

const ports = new Map<string, string>();
for (const [index, name] of PORT_VARIABLES.entries()) {
  ports.set(name, overrides[index] ?? String(reserved.pop()));
}

const inngestPort = ports.get("INNGEST_DEV_PORT");
const gatewayPort = ports.get("INNGEST_CONNECT_GATEWAY_PORT");

// The child environment. The two URLs are derived here rather than in the
// example app's own dev script, so the app and the CLI cannot disagree about
// where Inngest is; examples/package.json keeps a matching default for the case
// where someone runs that half on its own.
const env = {
  ...process.env,
  ...Object.fromEntries(ports),
  INNGEST_BASE_URL: `http://localhost:${inngestPort}`,
  INNGEST_CONNECT_GATEWAY_URL: `ws://localhost:${gatewayPort}/v0/connect`,
};

console.log(`[dev] Inngest Dev Server on http://localhost:${inngestPort}`);

const child = spawn(
  "pnpm",
  [
    "exec",
    "concurrently",
    "--kill-others-on-fail",
    "--names",
    "app,client,inngest",
    "--prefix-colors",
    "blue,green,magenta",
    "pnpm run dev:app",
    // Vite runs through scripts/dev-client.ts, whose header says what a plain
    // `pnpm --filter @wfgraph/client dev` does to Ctrl+C.
    "tsx scripts/dev-client.ts",
    "pnpm run dev:inngest",
  ],
  { stdio: "inherit", env }
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
