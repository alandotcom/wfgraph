import { zValidator } from "@hono/zod-validator";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { serve as serveInngest } from "inngest/hono";
import { z } from "zod";
import {
  getInngestClient,
  getInngestServeConfig,
} from "@/backend/lib/inngest/client";
import { getInngestFunctions } from "@/backend/lib/inngest/functions";
import { getAppLogger } from "@/backend/lib/logger";
import type { RpcContext } from "@/backend/rpc/context";
import {
  openApiReferenceHandler,
  openApiRestHandler,
} from "@/backend/rpc/openapi";
import { rpcRouter } from "@/backend/rpc/router";
import { postWorkflowResume } from "@/backend/services/workflows/workflow-resume.workflows";
import {
  optionsWorkflowWebhook,
  postWorkflowWebhook,
} from "@/backend/services/workflows/workflow-webhook.workflows";
import { listRuntimeActions } from "@/shared/workflow/action-registry";
import { listCustomWorkflowTriggers } from "@/shared/workflow/trigger-registry";

const idSchema = z.string().trim().min(1);
const workflowIdParamsSchema = z.object({ workflowId: idSchema });
const tokenParamsSchema = z.object({ token: idSchema });

const webhookBodySchema = z.record(z.string(), z.unknown());
const resumeBodySchema = z.record(z.string(), z.unknown());

const httpLogger = getAppLogger("http", "hono");

const BODY_LOG_LIMIT = 8192;
const isDevelopmentEnvironment = ["development", "dev"].includes(
  (Bun.env.NODE_ENV ?? "").trim().toLowerCase()
);
const LOG_HTTP_BODIES = isDevelopmentEnvironment;
const JSON_CONTENT_TYPES = [
  "application/json",
  "application/problem+json",
  "application/ld+json",
];
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const normalized = contentType.toLowerCase();
  return JSON_CONTENT_TYPES.some((jsonType) => normalized.includes(jsonType));
}

function buildRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function truncateTextForLogs(text: string): {
  value: string;
  truncated: boolean;
  originalLength: number;
} {
  if (text.length <= BODY_LOG_LIMIT) {
    return { value: text, truncated: false, originalLength: text.length };
  }

  return {
    value: text.slice(0, BODY_LOG_LIMIT),
    truncated: true,
    originalLength: text.length,
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getRequestLogBody(req: Request): Promise<unknown> {
  if (!METHODS_WITH_BODY.has(req.method.toUpperCase())) {
    return;
  }

  const contentType = req.headers.get("content-type") ?? undefined;
  if (!isJsonContentType(contentType)) {
    return;
  }

  const rawBody = await req.clone().text();
  if (!rawBody) {
    return;
  }

  const truncated = truncateTextForLogs(rawBody);
  const parsedValue = safeParseJson(truncated.value);

  if (!truncated.truncated) {
    return parsedValue;
  }

  return {
    truncated: true,
    originalLength: truncated.originalLength,
    value: parsedValue,
  };
}

async function getResponseLogBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get("content-type") ?? undefined;
  if (!isJsonContentType(contentType)) {
    return;
  }

  const rawBody = await res.clone().text();
  if (!rawBody) {
    return;
  }

  const truncated = truncateTextForLogs(rawBody);
  const parsedValue = safeParseJson(truncated.value);

  if (!truncated.truncated) {
    return parsedValue;
  }

  return {
    truncated: true,
    originalLength: truncated.originalLength,
    value: parsedValue,
  };
}

async function handleOpenApiReferenceRoute(
  request: Request
): Promise<Response | null> {
  const { matched, response } = await openApiReferenceHandler.handle(request, {
    prefix: "/api",
    context: { headers: request.headers },
  });

  if (!matched) {
    return null;
  }

  return response;
}

export function createApiApp() {
  const app = new Hono().basePath("/api");
  const rpcHandler = new RPCHandler<RpcContext>(rpcRouter);

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? buildRequestId();
    const startTime = Date.now();
    const method = c.req.method.toUpperCase();
    const path = c.req.path;
    const query = c.req.query();
    const requestBody = LOG_HTTP_BODIES
      ? await getRequestLogBody(c.req.raw)
      : undefined;
    const requestLogger = httpLogger.with({ requestId });

    requestLogger.info(`--> ${method} ${path} [${requestId}]`, {
      method,
      path,
      query,
      requestBody,
      userAgent: c.req.header("user-agent") ?? null,
      ip:
        c.req.header("x-forwarded-for") ??
        c.req.header("x-real-ip") ??
        c.req.header("cf-connecting-ip") ??
        null,
    });

    try {
      await next();
    } catch (error) {
      requestLogger.error(`xx> ${method} ${path} [${requestId}]`, {
        method,
        path,
        durationMs: Date.now() - startTime,
        error,
      });
      throw error;
    }

    const status = c.res.status;
    const responseBody =
      LOG_HTTP_BODIES && status >= 400
        ? await getResponseLogBody(c.res)
        : undefined;
    const responseLog = {
      method,
      path,
      statusCode: status,
      durationMs: Date.now() - startTime,
      responseBody,
    };
    const responseSummary = `<-- ${method} ${path} ${status} ${responseLog.durationMs}ms [${requestId}]`;

    if (status >= 500) {
      requestLogger.error(responseSummary, responseLog);
    } else if (status >= 400) {
      requestLogger.warn(responseSummary, responseLog);
    } else {
      requestLogger.info(responseSummary, responseLog);
    }
  });

  app.onError((error, c) => {
    httpLogger.error("Unhandled API error", {
      method: c.req.method.toUpperCase(),
      path: c.req.path,
      query: c.req.query(),
      error,
    });

    return c.json({ error: "Internal Server Error" }, 500);
  });

  const routes = app
    .use("/rpc/*", async (c, next) => {
      const { matched, response } = await rpcHandler.handle(c.req.raw, {
        prefix: "/api/rpc",
        context: { headers: c.req.raw.headers },
      });

      if (matched) {
        return c.newResponse(response.body, response);
      }

      await next();
    })
    .use("/rest/*", async (c, next) => {
      const { matched, response } = await openApiRestHandler.handle(c.req.raw, {
        prefix: "/api/rest",
        context: { headers: c.req.raw.headers },
      });

      if (matched) {
        return c.newResponse(response.body, response);
      }

      await next();
    })
    .get("/openapi.json", async (c) => {
      const response = await handleOpenApiReferenceRoute(c.req.raw);

      if (!response) {
        return c.json({ error: "Not found" }, 404);
      }

      return c.newResponse(response.body, response);
    })
    .get("/docs", async (c) => {
      const response = await handleOpenApiReferenceRoute(c.req.raw);

      if (!response) {
        return c.json({ error: "Not found" }, 404);
      }

      return c.newResponse(response.body, response);
    })
    .get("/extensions", (c) =>
      c.json({
        actions: listRuntimeActions(),
        triggers: listCustomWorkflowTriggers(),
      })
    )
    .all("/auth", (c) => c.json({ error: "Not found" }, 404))
    .all("/auth/*", (c) => c.json({ error: "Not found" }, 404))
    .all("/og", (c) => c.json({ error: "Not found" }, 404))
    .all("/og/*", (c) => c.json({ error: "Not found" }, 404))
    .on(["GET", "POST", "PUT"], "/inngest", async (c) => {
      const functions = await getInngestFunctions();
      const serveOptions = getInngestServeConfig();
      const inngestHandler = serveInngest({
        client: getInngestClient(),
        functions,
        ...(serveOptions as Record<string, unknown>),
      });
      return await inngestHandler(c);
    })
    .options("/workflows/:workflowId/webhook", () => optionsWorkflowWebhook())
    .post(
      "/workflows/:workflowId/webhook",
      zValidator("param", workflowIdParamsSchema),
      zValidator("json", webhookBodySchema),
      (c) =>
        postWorkflowWebhook({
          workflowId: c.req.valid("param").workflowId,
          authHeader: c.req.header("Authorization") ?? null,
          body: c.req.valid("json"),
        })
    )
    .post(
      "/workflows/hooks/:token/resume",
      zValidator("param", tokenParamsSchema),
      zValidator("json", resumeBodySchema),
      (c) =>
        postWorkflowResume(
          c.req.valid("param").token,
          c.req.valid("json"),
          c.req.header("Authorization") ?? null
        )
    );

  routes.notFound((c) => c.json({ error: "Not found" }, 404));

  return routes;
}

export const app = createApiApp();
