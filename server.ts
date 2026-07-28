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
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRovaApp } from "@rova/core/app";
// The repo's own entrypoint reaches into @rova/core for the logger createRovaApp
// already configured, so startup and shutdown land in the same JSON stream as
// every other line. An adopter hands Rova their logger through the `logger`
// option and uses that one here instead.
import { getAppLogger } from "@rova/core/backend/lib/logger";
// The same predicate Rova applies to the built bundle in production. Reaching
// for it here is what keeps one list of router-owned paths for both modes.
import { isSpaPath } from "@rova/core/backend/lib/http/client-assets";
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
 * Method matters as much as path, and the method half is the part Rova's own
 * copy has no need for. A POST or an OPTIONS preflight aimed under
 * `/workflows/` belongs to the API, which answers it or says 404 in its own
 * words; handing it a page of HTML would tell the caller nothing. Only a page
 * view gets the editor, and a page view is a GET.
 */
function isSpaRequest(method: string | undefined, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  return isSpaPath(pathname);
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

// Where Rova's own routes live, asked of the app rather than spelled out, so a
// mount under a base path moves this with it.
const apiPrefix = `${rova.basePath}/api`;

function isApiRequest(pathname: string): boolean {
  return pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`);
}

/**
 * Vite in middleware mode, sharing the HTTP server it will be dispatched from.
 *
 * The two need each other, which is why the server is created bare above and
 * given its request handler afterwards: the handler calls into Vite, and Vite
 * adds its HMR upgrade handler to the server.
 */
async function createDevelopmentVite(
  httpServer: Server
): Promise<ViteDevServer> {
  const { createServer: createViteServer } = await import("vite");

  return await createViteServer({
    server: {
      middlewareMode: true,
      // Sharing the HTTP server is what keeps the dev loop on one port: Vite
      // adds its HMR upgrade handler to it instead of opening a second listener
      // on 24678, which is what middleware mode does by default. 4017 is the
      // port `dev:inngest` polls. `ws.server` is the current spelling; the older
      // `hmr.server` is deprecated.
      ws: { server: httpServer },
    },
    // "custom" drops Vite's own HTML fallback, which would answer every
    // unmatched page-ish request with the SPA. The dispatch below decides that
    // instead, so the API keeps its 404s.
    appType: "custom",
  });
}

const server = createServer();

const vite = isProduction ? undefined : await createDevelopmentVite(server);

if (vite) {
  server.on("request", (request, response) => {
    const pathname = getPathname(request);

    // Rova's routes go straight to Rova, ahead of Vite. Vite's middleware stack
    // is not neutral about requests it does not own: it answers every CORS
    // preflight itself, so the webhook route's own preflight handler would never
    // run, and it rejects a request whose Host header is not a loopback name,
    // which is what a tunnelled webhook always carries.
    if (isApiRequest(pathname)) {
      void rovaListener(request, response);
      return;
    }

    // Everything else meets Vite's middlewares first, because the compiled SPA
    // asks for module, HMR and asset URLs that only Vite knows. A request it
    // does not recognise falls through to this callback: page views, which get
    // the editor, and anything else, which Rova answers or 404s.
    vite.middlewares(request, response, () => {
      if (isSpaRequest(request.method, pathname)) {
        void serveDevelopmentSpa(vite, request, response);
        return;
      }

      void rovaListener(request, response);
    });
  });
} else {
  // Production: Rova holds the built bundle and applies the SPA rule itself, so
  // there is nothing left here to route.
  server.on("request", (request, response) => {
    void rovaListener(request, response);
  });
}

const port = Number(process.env.PORT ?? DEFAULT_PORT);

// Middleware mode moves the listen call from Vite to here, and a standalone
// Vite dev server binds loopback by default for a reason: its /@fs route reads
// any file under the allow list, which is this whole repo. Development keeps
// that default. Setting HOST is how a developer opts into LAN exposure on
// purpose, for a phone on the same network. Production serves no such route and
// binds every interface, which is what a container needs.
const host = isProduction ? undefined : (process.env.HOST ?? "127.0.0.1");

server.listen(port, host, () => {
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
