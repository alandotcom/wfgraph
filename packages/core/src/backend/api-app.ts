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
  createOpenApiReferenceHandler,
  openApiRestHandler,
} from "@/backend/rpc/openapi";
import { rpcRouter } from "@/backend/rpc/router";
import { postWorkflowResume } from "@/backend/services/workflows/workflow-resume.workflows";
import {
  optionsWorkflowWebhook,
  postWorkflowWebhook,
} from "@/backend/services/workflows/workflow-webhook.workflows";
import { jsonObjectSchema } from "@/shared/types/json";
import { getErrorMessage } from "@/shared/utils";
import { listRuntimeActions } from "@/shared/workflow/action-registry";
import { listCustomWorkflowTriggers } from "@/shared/workflow/trigger-registry";

const idSchema = z.string().trim().min(1);
const workflowIdParamsSchema = z.object({ workflowId: idSchema });
const tokenParamsSchema = z.object({ token: idSchema });

// A webhook body is JSON by the time Hono has parsed it, and it stays JSON all
// the way to the run: Inngest stringifies it onto the event and the engine
// stores it in the JSONB `workflow_executions.input` column.
const webhookBodySchema = jsonObjectSchema;
const resumeBodySchema = z.record(z.string(), z.unknown());

const httpLogger = getAppLogger("http", "hono");
const rpcLogger = getAppLogger("rpc");

const BODY_LOG_LIMIT = 8192;
const isDevelopmentEnvironment = ["development", "dev"].includes(
  (process.env.NODE_ENV ?? "").trim().toLowerCase()
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

/**
 * Read a request body as JSON and validate it against a schema.
 *
 * Rova parses untrusted input at the route boundary, which is what the project
 * asks for anyway, so no validator middleware sits between the request and the
 * service. A body that is not JSON and a body that is the wrong shape both come
 * back as a message the caller can act on.
 */
async function parseJsonBody<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema
): Promise<
  { ok: true; data: z.infer<TSchema> } | { ok: false; error: string }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: "Request body must be valid JSON" };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }

  return { ok: true, data: parsed.data };
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
    return undefined;
  }

  const contentType = req.headers.get("content-type") ?? undefined;
  if (!isJsonContentType(contentType)) {
    return undefined;
  }

  const rawBody = await req.clone().text();
  if (!rawBody) {
    return undefined;
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
    return undefined;
  }

  const rawBody = await res.clone().text();
  if (!rawBody) {
    return undefined;
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

export type CreateApiAppOptions = {
  /**
   * Absolute path the API is reachable at, leading slash and no trailing slash,
   * for example "/api" or "/rova/api". The host tells us where it mounted Rova,
   * so nothing here has to deduce it from the request.
   */
  basePath: `/${string}`;
};

export function createApiApp(options: CreateApiAppOptions) {
  const { basePath } = options;
  const app = new Hono().basePath(basePath);
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
      requestLogger.error(
        `xx> ${method} ${path} [${requestId}]: ${getErrorMessage(error)}`,
        {
          method,
          path,
          durationMs: Date.now() - startTime,
          error,
        }
      );
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
    httpLogger.error(`Unhandled API error: ${getErrorMessage(error)}`, {
      method: c.req.method.toUpperCase(),
      path: c.req.path,
      query: c.req.query(),
      error,
    });

    return c.json({ error: "Internal Server Error" }, 500);
  });

  // oRPC needs to know the absolute path its handlers are mounted at so it can
  // strip that prefix before matching a procedure.
  function resolvePrefix(suffix: string): `/${string}` {
    return `${basePath}${suffix}`;
  }

  const openApiReferenceHandler = createOpenApiReferenceHandler(
    resolvePrefix("/rest")
  );

  const routes = app
    .use("/rpc/*", async (c, next) => {
      const { matched, response } = await rpcHandler.handle(c.req.raw, {
        prefix: resolvePrefix("/rpc"),
        context: { headers: c.req.raw.headers },
      });

      if (matched) {
        if (response.status >= 400) {
          try {
            const body = safeParseJson(await response.clone().text());
            rpcLogger.warn(`RPC error ${response.status} ${c.req.path}`, {
              status: response.status,
              path: c.req.path,
              body,
            });
          } catch {
            /* never break the response */
          }
        }
        return c.newResponse(response.body, response);
      }

      await next();
      return undefined;
    })
    .use("/rest/*", async (c, next) => {
      const { matched, response } = await openApiRestHandler.handle(c.req.raw, {
        prefix: resolvePrefix("/rest"),
        context: { headers: c.req.raw.headers },
      });

      if (matched) {
        return c.newResponse(response.body, response);
      }

      await next();
      return undefined;
    })
    .get("/openapi.json", async (c) => {
      const prefix = resolvePrefix("");
      const { matched, response } = await openApiReferenceHandler.handle(
        c.req.raw,
        { prefix, context: { headers: c.req.raw.headers } }
      );

      if (!matched) {
        return c.json({ error: "Not found" }, 404);
      }

      return c.newResponse(response.body, response);
    })
    .get("/docs", async (c) => {
      const prefix = resolvePrefix("");
      const { matched, response } = await openApiReferenceHandler.handle(
        c.req.raw,
        { prefix, context: { headers: c.req.raw.headers } }
      );

      if (!matched) {
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
    .post("/workflows/:workflowId/webhook", async (c) => {
      const params = workflowIdParamsSchema.safeParse(c.req.param());
      if (!params.success) {
        return c.json({ error: z.prettifyError(params.error) }, 400);
      }

      const body = await parseJsonBody(c.req.raw, webhookBodySchema);
      if (!body.ok) {
        return c.json({ error: body.error }, 400);
      }

      return await postWorkflowWebhook({
        workflowId: params.data.workflowId,
        authHeader: c.req.header("Authorization") ?? null,
        body: body.data,
      });
    })
    .post("/workflows/hooks/:token/resume", async (c) => {
      const params = tokenParamsSchema.safeParse(c.req.param());
      if (!params.success) {
        return c.json({ error: z.prettifyError(params.error) }, 400);
      }

      const body = await parseJsonBody(c.req.raw, resumeBodySchema);
      if (!body.ok) {
        return c.json({ error: body.error }, 400);
      }

      return await postWorkflowResume(
        params.data.token,
        body.data,
        c.req.header("Authorization") ?? null
      );
    });

  routes.notFound((c) => c.json({ error: "Not found" }, 404));

  return routes;
}
