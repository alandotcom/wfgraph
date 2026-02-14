import { serve } from "bun";
import { app as apiApp } from "@/backend/app";
import { runMigrationsIfRequested } from "@/backend/lib/db/migrations";
import { configureAppLogging, getAppLogger } from "@/backend/lib/logger";
import { initializeWorkflowTriggers } from "@/backend/lib/workflow-trigger-bootstrap";
import appHtml from "@/client/index.html";

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

configureAppLogging();
initializeWorkflowTriggers();
const logger = getAppLogger("server");
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.warn("Shutting down", { signal });
  try {
    server.stop(true);
  } catch (error) {
    logger.error("Failed to stop server gracefully", { error });
  }
  process.exit(0);
}

await runMigrationsIfRequested();

const server = serve({
  port: Number(Bun.env.PORT ?? 4017),
  development: Bun.env.NODE_ENV !== "production",
  routes: {
    "/": appHtml,
    "/workflows": appHtml,
    "/workflows/:workflowId": appHtml,
  },
  fetch(req) {
    const url = new URL(req.url);
    const pathname = normalizePath(url.pathname);

    if (pathname.startsWith("/api/")) {
      return apiApp.fetch(req);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

for (const signal of shutdownSignals) {
  process.on(signal, () => {
    shutdown(signal);
  });
}

logger.info("Server listening", {
  url: server.url,
  port: Number(Bun.env.PORT ?? 4017),
});
