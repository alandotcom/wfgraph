import { serve } from "bun";
import { configureAppLogging, getAppLogger } from "@/backend/lib/logger";
import appHtml from "../../client/index.html";
import { app as apiApp } from "./hono-app";

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

configureAppLogging();
const logger = getAppLogger("server");

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

logger.info("Server listening", {
  url: server.url,
  port: Number(Bun.env.PORT ?? 4017),
});
