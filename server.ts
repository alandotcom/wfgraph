/**
 * This repo's own server, for `pnpm run dev` and for `pnpm run start`.
 *
 * It is the adopter path written out: `createRovaApp` returns a fetch handler,
 * `createRequestListener` from `@rova/core/node` turns one into something
 * `node:http` accepts, and that is the whole mount. What is left here serves the
 * development loop rather than a consumer, which is why it lives at the repo
 * root and `@rova/core` publishes no server wrapper of its own.
 *
 * The one difference between the two modes is where the editor comes from.
 * Production hands the built bundle to `createRovaApp`, exactly as a host does,
 * so `pnpm run start` exercises the client-serving code that ships. Development
 * has no build to hand over, so Vite runs in middleware mode inside this same
 * process and compiles the SPA per request. One process either way, on one port,
 * which is the port `dev:inngest` polls before it starts.
 */

// First, so the rest of the graph loads with .env already applied.
import "./load-env";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRovaApp } from "@rova/core/app";
// The repo's own entrypoint reaches into @rova/core for the logger createRovaApp
// already configured, so startup and shutdown land in the same JSON stream as
// every other line. An adopter hands Rova their logger through the `logger`
// option and uses that one here instead.
import { getAppLogger } from "@rova/core/backend/lib/logger";
import { createRequestListener } from "@rova/core/node";
import "@rova/plugins";
import "@rova/plugins/server";
import type { ViteDevServer } from "vite";

const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";
const DEFAULT_PORT = 4017;

// The file Vite compiles on demand in development. Its production counterpart is
// the built index.html inside @rova/client's bundle directory.
const CLIENT_ENTRY_HTML = fileURLToPath(
  new URL("./packages/client/src/index.html", import.meta.url)
);

// Paths the browser router owns, and the only ones that answer with the editor.
// @rova/core applies the same rule to the built bundle; this is the development
// copy of it, and the two have to agree or a route would work in one mode only.
const SPA_PATHS = new Set(["/", "/workflows"]);

const isProduction = process.env.NODE_ENV === "production";

const serverLogger = getAppLogger("server");

function toOptionalUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

/**
 * True for the requests that should answer with the editor's HTML.
 *
 * Method matters as much as path. A POST or an OPTIONS preflight aimed under
 * `/workflows/` belongs to the API, which answers it or says 404 in its own
 * words; handing it a page of HTML would tell the caller nothing. Only a page
 * view gets the editor, and a page view is a GET.
 */
function isSpaRequest(method: string | undefined, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  return SPA_PATHS.has(pathname) || pathname.startsWith("/workflows/");
}

function getPathname(request: IncomingMessage): string {
  // A Node request line carries a path, not an absolute URL, so URL needs a base
  // it can throw away.
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

/**
 * Answer a page view with the SPA shell Vite has just compiled.
 *
 * `transformIndexHtml` is what injects Vite's client script and the React Fast
 * Refresh preamble; the file on disk carries neither, and the browser reports
 * "can't detect preamble" without them.
 */
async function serveDevelopmentSpa(
  vite: ViteDevServer,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const html = await readFile(CLIENT_ENTRY_HTML, "utf-8");
    const transformed = await vite.transformIndexHtml(request.url ?? "/", html);

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(transformed);
  } catch (error) {
    if (error instanceof Error) {
      vite.ssrFixStacktrace(error);
    }
    serverLogger.error("Failed to compile the editor", { error });
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end("Failed to compile the editor. See the server log.");
  }
}

const rova = await createRovaApp({
  // This server binds to localhost for a developer's own machine, so nothing in
  // front of it needs gating. A deployment of this same file behind a real
  // hostname has to replace this with a predicate.
  auth: "external",
  // Handing the bundle over is what turns the editor on. In development there is
  // no bundle, so Rova serves the API alone and Vite answers everything else.
  client: isProduction
    ? (await import("@rova/client")).clientBundle
    : undefined,
  database: {
    url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
  encryption: {
    key: process.env.INTEGRATION_ENCRYPTION_KEY ?? "",
  },
  migrations: {
    runOnStartup: process.env.RUN_DB_MIGRATIONS === "true",
    migrationsDir: process.env.MIGRATIONS_DIR,
  },
  inngest: {
    id: process.env.INNGEST_APP_ID ?? "notifications-workflow",
    isDev: !isProduction,
    baseUrl:
      toOptionalUrl(process.env.INNGEST_BASE_URL) ??
      toOptionalUrl(process.env.INNGEST_DEV),
    eventKey: process.env.INNGEST_EVENT_KEY,
    env: process.env.INNGEST_ENV,
    signingKey: process.env.INNGEST_SIGNING_KEY,
    signingKeyFallback: process.env.INNGEST_SIGNING_KEY_FALLBACK,
    serveOrigin: process.env.INNGEST_SERVE_ORIGIN,
    servePath: process.env.INNGEST_SERVE_PATH,
  },
});

const rovaListener = createRequestListener(rova);

// Assigned below, before the server accepts anything. It has to be declared
// first because Vite and the HTTP server each need the other: the handler
// dispatches to Vite, and Vite upgrades its HMR WebSocket on the HTTP server.
let vite: ViteDevServer | undefined;

const server = createServer((request, response) => {
  const devServer = vite;

  if (!devServer) {
    // Production: Rova holds the built bundle and applies the SPA rule itself,
    // so there is nothing left here to route.
    void rovaListener(request, response);
    return;
  }

  if (isSpaRequest(request.method, getPathname(request))) {
    void serveDevelopmentSpa(devServer, request, response);
    return;
  }

  // Everything else meets Vite's middlewares first, because the compiled SPA
  // asks for module, HMR and asset URLs that only Vite knows. A request it does
  // not recognise falls through to the callback, which is every API route and
  // every method Vite ignores.
  devServer.middlewares(request, response, () => {
    void rovaListener(request, response);
  });
});

if (!isProduction) {
  const { createServer: createViteServer } = await import("vite");

  vite = await createViteServer({
    server: {
      middlewareMode: true,
      // Handing Vite the HTTP server above is what keeps the dev loop on one
      // port: Vite adds its HMR upgrade handler to it instead of opening a
      // second listener on 24678, which is what middleware mode does by
      // default. 4017 is the port `dev:inngest` polls.
      ws: { server },
    },
    // "custom" drops Vite's own HTML fallback, which would answer every
    // unmatched page-ish request with the SPA. The dispatch above decides that
    // instead, so the API keeps its 404s.
    appType: "custom",
  });
}

const port = Number(process.env.PORT ?? DEFAULT_PORT);

server.listen(port, () => {
  const url = `http://localhost:${port}/`;
  serverLogger.info(`Rova listening on ${url}`, { url });
});

/**
 * A reload replaces the whole process here: `tsx watch` kills it and starts a
 * new one, so `server` and `vite` above are as long-lived as anything gets and
 * module scope holds them safely. A watcher that re-evaluated the module graph
 * inside a process that stayed up would need these on globalThis instead,
 * because otherwise an earlier run's signal handler stays closed over a server
 * it has already stopped.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void (async () => {
      serverLogger.warn("Received shutdown signal", { signal });
      try {
        await vite?.close();
        // Vite's HMR websocket and any keep-alive connection stay open for as
        // long as the client holds them, and `close` waits on every one, so a
        // developer pressing ctrl-C with the editor open would otherwise wait
        // for a browser tab to give up.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } catch (error) {
        serverLogger.error("Failed to stop the server", { error });
      }
      process.exit(0);
    })();
  });
}
