import { RPCHandler } from "@orpc/server/fetch";
import { Effect, Result, Schema, type SchemaAST } from "effect";
import { Hono } from "hono";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { responseFromServiceFailure } from "#src/backend/lib/http/failure-response";
import type { InngestServeHandler } from "#src/backend/lib/inngest/client";
import { getAppLogger } from "#src/backend/lib/logger";
import { isNil, omitBy } from "es-toolkit";
import {
  type Authorize,
  UNAUTHORIZED_BODY,
} from "#src/backend/lib/http/authorize";
import type { RpcContext } from "#src/backend/rpc/context";
import type { WfGraphRuntime } from "#src/backend/runtime";
import {
  createOpenApiReferenceHandler,
  openApiRestHandler,
} from "#src/backend/rpc/openapi";
import { rpcRouter } from "#src/backend/rpc/router";
import { postWorkflowResume } from "#src/backend/services/workflows/lifecycle/resume";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { formatSchemaFailure } from "@wfgraph/shared/types/schema-message";
import {
  NonEmptyTrimmedString,
  rejectUnknownKeys,
} from "@wfgraph/shared/types/schema";
import { getErrorMessage } from "@wfgraph/shared/utils";

// A path segment is whatever the sender typed, so the refusal names the field
// and the rule rather than echoing the value back into the response body.
// `errors: "all"` is what `formatSchemaFailure` is written against: it counts
// the issues it did not spell out, and stopping at the first would make that
// count always zero.
const readParams = {
  ...rejectUnknownKeys,
  errors: "all",
} as const satisfies SchemaAST.ParseOptions;
const readTokenParams = Schema.decodeUnknownResult(
  Schema.Struct({ token: NonEmptyTrimmedString }),
  readParams
);

const httpLogger = getAppLogger("http", "hono");

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

/**
 * The RPC procedures the editor's run panel reads on a timer while a run is on
 * screen. One open workflow turns them into a line every two seconds, which
 * buries whatever the person was reading, so a successful poll logs at trace.
 * `LOG_LEVEL=trace` brings them back; a failing one still logs at its status.
 */
const POLLED_RPC_PROCEDURES = new Set([
  "workflow/getExecutions",
  "workflow/getExecutionLogs",
  "workflow/getExecutionEvents",
  "workflow/getExecutionStatus",
]);

function isPolledProcedure(path: string): boolean {
  const rpcMarker = "/rpc/";
  const procedureStart = path.indexOf(rpcMarker);
  return (
    procedureStart >= 0 &&
    POLLED_RPC_PROCEDURES.has(path.slice(procedureStart + rpcMarker.length))
  );
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  const normalized = contentType.toLowerCase();
  return JSON_CONTENT_TYPES.some((jsonType) => normalized.includes(jsonType));
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
 * Read a request body as the JSON object a resume call carries.
 *
 * Workflow Graph parses untrusted input at the route boundary, which is what the project
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
   * for example "/api" or "/wfgraph/api". The host tells us where it mounted Workflow Graph,
   * so nothing here has to deduce it from the request.
   */
  basePath: `/${string}`;
  /** Every route answers to this except those in `machineRoutes`. */
  authorize: Authorize;
  /**
   * The Effect runtime the app instance owns, put on every request context so a
   * procedure whose service has been migrated can run its Effect on it.
   */
  runtime: WfGraphRuntime;
  /**
   * The `/inngest` HTTP serve handler. Absent when the host opted into Connect:
   * that mode dials out over a WebSocket and must not expose a callback route
   * that Inngest cannot reach on a private network.
   */
  inngestHandler?: InngestServeHandler;
};

/**
 * Where a parked wait is resumed by token. Local to this file, since the editor
 * resumes over RPC and nothing else addresses the path.
 */
const WAIT_RESUME_ROUTE = "/workflows/waits/:token/resume";

const INNGEST_SERVE_ROUTE = "/inngest";

/**
 * Routes reached by machines, each carrying a credential of its own: Inngest
 * signs its HTTP callback (when that route is mounted), the resume path carries
 * a resume token. A session check would break both.
 *
 * Written as the exception, so a route added to this file is gated by default
 * and opening one is an edit here with a reason attached. Listing what to gate
 * instead fails the other way: forgetting it publishes an endpoint silently.
 *
 * Inngest verifies that signature only in cloud mode and with a signing key
 * configured; `reportInngestCallbackExposure` says so at startup when the HTTP
 * serve path is mounted and neither holds. Connect mode mounts no `/inngest`
 * route, so it is absent from this list then.
 *
 * Each path is named rather than spelled out, so the gate and the route
 * registration below cannot drift apart into a silent 401 for every sender.
 */
export function machineRoutes(options: {
  serveInngest: boolean;
}): readonly string[] {
  return options.serveInngest
    ? [INNGEST_SERVE_ROUTE, WAIT_RESUME_ROUTE]
    : [WAIT_RESUME_ROUTE];
}

type ApiEnv = {
  Variables: { wfgraphMachineRoute?: true };
};

export function createApiApp(options: CreateApiAppOptions) {
  const { basePath, authorize, runtime, inngestHandler } = options;
  const app = new Hono<ApiEnv>().basePath(basePath);
  const rpcHandler = new RPCHandler<RpcContext>(rpcRouter);
  const ungatedRoutes = machineRoutes({
    serveInngest: inngestHandler !== undefined,
  });

  // One record per request, written once the answer is known. The message says
  // what happened and the properties carry the payloads, which in development
  // is the part worth reading.
  app.use("*", async (c, next) => {
    const startTime = Date.now();
    const method = c.req.method.toUpperCase();
    const path = c.req.path;
    const requestBody = LOG_HTTP_BODIES
      ? await getRequestLogBody(c.req.raw)
      : undefined;

    try {
      await next();
    } catch (error) {
      httpLogger.error(
        `${method} ${path} threw after ${Date.now() - startTime}ms: ${getErrorMessage(error)}`,
        omitBy({ requestBody, error }, isNil)
      );
      throw error;
    }

    const status = c.res.status;
    // A refusal carries its reason in its body, and that is the one payload
    // worth reading back in production, where the rest stay unread.
    const responseBody =
      LOG_HTTP_BODIES || status >= 400
        ? await getResponseLogBody(c.res)
        : undefined;
    const summary = `${method} ${path} ${status} ${Date.now() - startTime}ms`;
    const bodies = omitBy({ requestBody, responseBody }, isNil);

    if (status >= 500) {
      httpLogger.error(summary, bodies);
    } else if (status >= 400) {
      httpLogger.warn(summary, bodies);
    } else if (isPolledProcedure(path)) {
      httpLogger.trace(summary, bodies);
    } else {
      httpLogger.info(summary, bodies);
    }
  });

  // Markers before the gate: Hono runs matching middleware in registration order.
  for (const route of ungatedRoutes) {
    app.use(route, async (c, next) => {
      c.set("wfgraphMachineRoute", true);
      await next();
    });
  }

  app.use("*", async (c, next) => {
    if (c.get("wfgraphMachineRoute") || (await authorize(c.req.raw))) {
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
        context: { headers: c.req.raw.headers, runtime },
      });

      if (matched) {
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
    // The catalog is the whole surface in one document, and the only channel the
    // editor learns it through: an Event, an action and an integration all reach it
    // here, the built-in Condition and Wait and a host's own actions included.
    .get("/extensions", async (c) =>
      c.json({
        catalog: (await runtime.runPromise(Extensions)).catalog,
      })
    )
    .all("/auth", (c) => c.json({ error: "Not found" }, 404))
    .all("/auth/*", (c) => c.json({ error: "Not found" }, 404))
    .all("/og", (c) => c.json({ error: "Not found" }, 404))
    .all("/og/*", (c) => c.json({ error: "Not found" }, 404));

  if (inngestHandler) {
    routes.on(["GET", "POST", "PUT"], INNGEST_SERVE_ROUTE, (c) =>
      inngestHandler(c)
    );
  }

  routes.post(WAIT_RESUME_ROUTE, async (c) => {
    const params = readTokenParams(c.req.param());
    if (Result.isFailure(params)) {
      return c.json({ error: formatSchemaFailure(params.failure.issue) }, 400);
    }

    const body = await parseJsonObjectBody(c.req.raw);
    if (!body.ok) {
      return c.json({ error: body.error }, 400);
    }

    return await runtime.runPromise(
      postWorkflowResume({
        token: params.success.token,
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
