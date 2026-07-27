/**
 * This repo's own dev server.
 *
 * It is the adopter path written out: `createRovaApp` returns a fetch handler
 * and `Bun.serve` takes one. What is left here serves the development loop
 * rather than a consumer, which is why it lives at the repo root and
 * `@rova/core` publishes no server wrapper of its own.
 */

import { createRovaApp } from "@rova/core/app";
// The repo's own entrypoint reaches into @rova/core for the logger createRovaApp
// already configured, so startup and shutdown land in the same JSON stream as
// every other line. An adopter hands Rova their logger through the `logger`
// option and uses that one here instead.
import { getAppLogger } from "@rova/core/backend/lib/logger";
import "@rova/plugins";
import "@rova/plugins/server";
// Bun turns this into a bundle whose script and link tags it transpiles per request, so
// running the dev server needs no client build first. The import lives here, in the
// unpublished dev entrypoint, to keep the client out of @rova/core's own bundle.
import homepage from "./packages/core/client/index.html";

const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";
const DEFAULT_PORT = 4017;

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
 * `bun --hot` re-runs this module on every save, and a reload re-evaluates the
 * whole module graph, so module-scoped state starts over each time and nothing
 * accumulates there. globalThis is the exception, which is where Rova's runtime
 * singletons live and where these two belong:
 *
 * - the running server, so a signal handler installed by an earlier run stops
 *   whichever server is live rather than the one it closed over;
 * - a flag, because `process.on` stacks a fresh listener per reload and a long
 *   session would end up with dozens.
 */
declare global {
  var __rovaDevServer: Bun.Server<undefined> | undefined;
  var __rovaDevSignalsInstalled: boolean | undefined;
}

const rova = await createRovaApp({
  // This server binds to localhost for a developer's own machine, so nothing in
  // front of it needs gating. A deployment of this same file behind a real
  // hostname has to replace this with a predicate.
  auth: "external",
  database: {
    url: Bun.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
  encryption: {
    key: Bun.env.INTEGRATION_ENCRYPTION_KEY ?? "",
  },
  migrations: {
    runOnStartup: Bun.env.RUN_DB_MIGRATIONS === "true",
    migrationsDir: Bun.env.MIGRATIONS_DIR,
  },
  inngest: {
    client: {
      id: Bun.env.INNGEST_APP_ID ?? "notifications-workflow",
      isDev: Bun.env.NODE_ENV !== "production",
      baseUrl:
        toOptionalUrl(Bun.env.INNGEST_BASE_URL) ??
        toOptionalUrl(Bun.env.INNGEST_DEV),
      eventKey: Bun.env.INNGEST_EVENT_KEY,
      env: Bun.env.INNGEST_ENV,
    },
    serve: {
      signingKey: Bun.env.INNGEST_SIGNING_KEY,
      signingKeyFallback: Bun.env.INNGEST_SIGNING_KEY_FALLBACK,
      serveHost: Bun.env.INNGEST_SERVE_HOST,
      servePath: Bun.env.INNGEST_SERVE_PATH,
    },
  },
});

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? DEFAULT_PORT),
  development: Bun.env.NODE_ENV !== "production",
  // Bun matches routes before it calls fetch, so these paths get the
  // transpiled-on-demand client and rova.fetch never sees them. This is the one
  // thing the dev server does that a consumer does not: a published consumer
  // has a prebuilt client in dist and no client source to transpile.
  routes: {
    "/": homepage,
    "/workflows": homepage,
    "/workflows/*": homepage,
  },
  fetch: rova.fetch,
});

globalThis.__rovaDevServer = server;

const serverLogger = getAppLogger("server");

if (!globalThis.__rovaDevSignalsInstalled) {
  globalThis.__rovaDevSignalsInstalled = true;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        serverLogger.warn("Received shutdown signal", { signal });
        try {
          await globalThis.__rovaDevServer?.stop(true);
        } catch (error) {
          serverLogger.error("Failed to stop the server", { error });
        }
        process.exit(0);
      })();
    });
  }
}

serverLogger.info(`Rova listening on ${server.url}`, {
  url: server.url.toString(),
});
