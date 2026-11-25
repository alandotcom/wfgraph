/**
 * Runs `pnpm run start` against the output of `pnpm run build`, on a free port
 * with a throwaway SQLite file and encryption key, then checks that `/login`
 * answers 200 and that a signed-in `GET /` serves the built editor's
 * index.html. It fails when the app cannot find its client bundle at startup.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "wfgraph-start-"));

/** Asks the OS for an unused port by binding port 0 and releasing it. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolvePort(address.port)
          : reject(new Error("The probe server reported no port"))
      );
    });
  });
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
// `detached` puts pnpm and the node process under it in one process group,
// which the `finally` block stops as a whole.
const app = spawn("pnpm", ["run", "start"], {
  cwd: root,
  detached: true,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: String(port),
    SQLITE_PATH: resolve(temporaryDirectory, "smoke.sqlite"),
    INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  },
});

try {
  const loginStatus = await waitForLogin(Date.now() + 60_000);
  if (loginStatus !== 200) {
    throw new Error(`GET /login answered ${loginStatus}`);
  }

  const signIn = await fetch(`${origin}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { origin },
    body: new URLSearchParams({ username: "admin", password: "password" }),
  });
  const session = signIn.headers.getSetCookie()[0]?.split(";")[0];
  if (signIn.status !== 303 || session === undefined) {
    throw new Error(`POST /login answered ${signIn.status} with no session`);
  }

  const page = await fetch(`${origin}/`, { headers: { cookie: session } });
  const builtIndex = readFileSync(
    resolve(root, "packages/client/dist/client/index.html"),
    "utf8"
  );
  if (page.status !== 200 || (await page.text()) !== builtIndex) {
    throw new Error(`GET / answered ${page.status} without the built editor`);
  }
  console.log(`pnpm run start served the built editor on ${origin}`);
} finally {
  if (app.pid !== undefined && app.exitCode === null) process.kill(-app.pid);
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

/** Polls `/login` every 500ms and returns the first status the app answers with. */
async function waitForLogin(deadline: number): Promise<number> {
  if (app.exitCode !== null) {
    throw new Error(`pnpm run start exited with code ${app.exitCode}`);
  }
  if (Date.now() > deadline) {
    throw new Error(`pnpm run start did not answer on ${origin} in time`);
  }
  const status = await fetch(`${origin}/login`).then(
    (response) => response.status,
    () => undefined
  );
  if (status !== undefined) return status;
  await sleep(500);
  return waitForLogin(deadline);
}
