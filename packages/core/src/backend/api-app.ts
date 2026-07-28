import { RPCHandler } from "@orpc/server/fetch";
import { Effect } from "effect";
import { Hono } from "hono";
import { serve as serveInngest } from "inngest/hono";
import { z } from "zod";
import { responseFromServiceFailure } from "#src/backend/lib/http/failure-response";
import {
  getInngestClient,
  getInngestServeConfig,
} from "#src/backend/lib/inngest/client";
import { getInngestFunctions } from "#src/backend/lib/inngest/functions";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  type Authorize,
  UNAUTHORIZED_BODY,
} from "#src/backend/lib/http/authorize";
import type { RpcContext } from "#src/backend/rpc/context";
import type { RovaRuntime } from "#src/backend/runtime";
import {
  createOpenApiReferenceHandler,
  openApiRestHandler,
} from "#src/backend/rpc/openapi";
import { rpcRouter } from "#src/backend/rpc/router";
import { postWorkflowResume } from "#src/backend/services/workflows/triggering/resume";
import { postWorkflowWebhook } from "#src/backend/services/workflows/triggering/webhook";
import { type JsonObject, readJsonObject } from "@rova/shared/types/json";
import { getErrorMessage } from "@rova/shared/utils";
import { listRuntimeActions } from "@rova/shared/workflow/action-registry";
import { listCustomWorkflowTriggers } from "@rova/shared/workflow/trigger-registry";

const idSchema = z.string().trim().min(1);
const workflowIdParamsSchema = z.object({ workflowId: idSchema });
const tokenParamsSchema = z.object({ token: idSchema });

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
 * Read a request body as the JSON object a webhook or a resume call carries.
 *
 * Rova parses untrusted input at the route boundary, which is what the project
 * asks for anyway, so no validator middleware sits between the request and the
 * service. A body that is not JSON and a body that is JSON but not an object
 * both come back as a message the caller can act on.
 */
async function parseJsonObjectBody(
  request: Request
): Promise<{ ok: true; data: JsonObject } | { ok: false; error: string }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: "Request body must be valid JSON" };
  }

  const body = readJsonObject(raw);
  if (!body) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  return { ok: true, data: body };
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
  /** Every route answers to this except those in MACHINE_ROUTES. */
  authorize: Authorize;
  /**
   * The Effect runtime the app instance owns, put on every request context so a
   * procedure whose service has been migrated can run its Effect on it.
   */
  runtime: RovaRuntime;
};

/**
 * Routes reached by machines, each carrying a credential of its own: Inngest
 * signs its callback, the webhook path checks an API key, the resume path a hook
 * token. A session check would break all three.
 *
 * Written as the exception, so a route added to this file is gated by default
 * and opening one is an edit here with a reason attached. Listing what to gate
 * instead fails the other way: forgetting it publishes an endpoint silently.
 *
 * Inngest verifies that signature only when a signing key is configured;
 * `reportInngestCallbackExposure` says so at startup when one is not.
 */
export const MACHINE_ROUTES = [
  "/inngest",
  "/workflows/:workflowId/webhook",
  "/workflows/hooks/:token/resume",
] as const;

const WEBHOOK_ROUTE = "/workflows/:workflowId/webhook";

/**
 * The webhook intake endpoint is called from browsers and from third-party
 * senders, so it answers preflight requests and carries these on every answer it
 * gives. CORS is a property of the transport, which is why it is stated here
 * beside the routes rather than inside the service.
 */
const webhookCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

type ApiEnv = {
  Variables: { rovaMachineRoute?: true; rovaWebhookRoute?: true };
};

export function createApiApp(options: CreateApiAppOptions) {
  const { basePath, authorize, runtime } = options;
  const app = new Hono<ApiEnv>().basePath(basePath);
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

  // Markers before the gate: Hono runs matching middleware in registration order.
  for (const route of MACHINE_ROUTES) {
    app.use(route, async (c, next) => {
      c.set("rovaMachineRoute", true);
      await next();
    });
  }

  // Marks the one route whose failures still need CORS. A defect leaves the
  // route handler through `onError`, which builds its 500 without knowing what
  // was being served, and a sender reading a bodyless opaque response cannot
  // tell an outage from a rejection.
  app.use(WEBHOOK_ROUTE, async (c, next) => {
    c.set("rovaWebhookRoute", true);
    await next();
  });

  app.use("*", async (c, next) => {
    if (c.get("rovaMachineRoute") || (await authorize(c.req.raw))) {
      await next();
      return undefined;
    }

    return c.json(UNAUTHORIZED_BODY, 401);
  });

  app.onError((error, c) => {
    httpLogger.error(`Unhandled API error: ${getErrorMessage(error)}`, {
      method: c.req.method.toUpperCase(),
      path: c.req.path,
      query: c.req.query(),
      error,
    });

    return c.json(
      { error: "Internal Server Error" },
      500,
      c.get("rovaWebhookRoute") ? webhookCorsHeaders : undefined
    );
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
        context: { headers: c.req.raw.headers, runtime },
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
        context: { headers: c.req.raw.headers, runtime },
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
        { prefix, context: { headers: c.req.raw.headers, runtime } }
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
        { prefix, context: { headers: c.req.raw.headers, runtime } }
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
      // The registry is where this app's runtime reaches the event listeners it
      // builds: they run migrated services, and nothing there may reach for a
      // runtime of its own.
      const functions = await getInngestFunctions(runtime);
      const inngestHandler = serveInngest({
        client: getInngestClient(),
        functions,
        // Spread of a typed pair, so a serve option Inngest renames stops
        // compiling rather than being silently dropped on the floor.
        ...getInngestServeConfig(),
      });
      return await inngestHandler(c);
    })
    .options(WEBHOOK_ROUTE, () =>
      Response.json({}, { headers: webhookCorsHeaders })
    )
    .post(WEBHOOK_ROUTE, async (c) => {
      // Both refusals below carry the CORS headers for the same reason the
      // service's failures do: a browser-side sender reading an opaque response
      // cannot tell a malformed request from an outage.
      const params = workflowIdParamsSchema.safeParse(c.req.param());
      if (!params.success) {
        return c.json(
          { error: z.prettifyError(params.error) },
          400,
          webhookCorsHeaders
        );
      }

      const body = await parseJsonObjectBody(c.req.raw);
      if (!body.ok) {
        return c.json({ error: body.error }, 400, webhookCorsHeaders);
      }

      return await runtime.runPromise(
        postWorkflowWebhook({
          workflowId: params.data.workflowId,
          authHeader: c.req.header("Authorization") ?? null,
          body: body.data,
        }).pipe(
          Effect.match({
            onSuccess: (data) =>
              Response.json(data, { headers: webhookCorsHeaders }),
            onFailure: (failure) =>
              responseFromServiceFailure(failure, {
                headers: webhookCorsHeaders,
              }),
          })
        )
      );
    })
    .post("/workflows/hooks/:token/resume", async (c) => {
      const params = tokenParamsSchema.safeParse(c.req.param());
      if (!params.success) {
        return c.json({ error: z.prettifyError(params.error) }, 400);
      }

      const body = await parseJsonObjectBody(c.req.raw);
      if (!body.ok) {
        return c.json({ error: body.error }, 400);
      }

      return await runtime.runPromise(
        postWorkflowResume({
          token: params.data.token,
          body: body.data,
          authHeader: c.req.header("Authorization") ?? null,
        }).pipe(
          Effect.match({
            onSuccess: (data) => Response.json(data),
            onFailure: (failure) => responseFromServiceFailure(failure),
          })
        )
      );
    });

  routes.notFound((c) => c.json({ error: "Not found" }, 404));

  return routes;
}
