import { RPCHandler } from "@orpc/server/fetch";
import { Effect, Result, Schema, type SchemaAST } from "effect";
import { Hono } from "hono";
import { AgentConfig } from "#src/backend/agent/config";
import { Extensions } from "#src/backend/lib/effect/extensions";
import { responseFromServiceFailure } from "#src/backend/lib/http/failure-response";
import type { InngestServeHandler } from "#src/backend/lib/inngest/client";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  createRequestEvent,
  type RequestEvent,
} from "#src/backend/lib/http/request-event";
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

const httpLogger = getAppLogger("http");

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

/**
 * The procedure a path addresses, for example "workflow/create" out of
 * "/api/rpc/workflow/create". Null for every path that is not an RPC call.
 */
function rpcProcedureOf(path: string): string | null {
  const rpcMarker = "/rpc/";
  const procedureStart = path.indexOf(rpcMarker);
  if (procedureStart < 0) {
    return null;
  }

  const procedure = path.slice(procedureStart + rpcMarker.length);
  return procedure || null;
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
  Variables: {
    wfgraphMachineRoute?: true;
    /** The record this request will write, shared with the oRPC handler. */
    wfgraphRequestEvent: RequestEvent;
  };
};

/** How much of a refusal's own wording reaches the log line. */
const ERROR_MESSAGE_LIMIT = 200;

/**
 * The reason a refusal gives, for a route that answers without going through
 * the oRPC handler: a 404, the auth gate's 401, the wait-resume route's 400.
 * An oRPC procedure puts a better-typed reason on the request event itself.
 */
async function readRefusalMessage(res: Response): Promise<string | undefined> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) {
    return undefined;
  }

  try {
    const body = readJsonObject(await res.clone().json());
    const reason = body?.error ?? body?.message;
    return typeof reason === "string"
      ? reason.slice(0, ERROR_MESSAGE_LIMIT)
      : undefined;
  } catch {
    return undefined;
  }
}

export function createApiApp(options: CreateApiAppOptions) {
  const { basePath, authorize, runtime, inngestHandler } = options;
  const app = new Hono<ApiEnv>().basePath(basePath);
  const rpcHandler = new RPCHandler<RpcContext>(rpcRouter);
  const ungatedRoutes = machineRoutes({
    serveInngest: inngestHandler !== undefined,
  });

  // One record per request, written once the answer is known. Everything the
  // request learned about itself on the way through is on the event: the
  // procedure it addressed, and the reason it was refused. No payload is
  // logged. A body large enough to matter is large enough to bury the line
  // beside it, and both directions are already readable from the client.
  app.use("*", async (c, next) => {
    const startTime = Date.now();
    const method = c.req.method.toUpperCase();
    const path = c.req.path;
    const procedure = rpcProcedureOf(path);
    const event = createRequestEvent();
    c.set("wfgraphRequestEvent", event);
    event.set({
      http: { method, path },
      ...(procedure === null ? {} : { rpc: { procedure } }),
    });

    try {
      await next();
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      event.set({
        http: { method, path, ms: elapsedMs },
        error: { message: getErrorMessage(error) },
      });
      httpLogger.error(
        `${method} ${path} threw after ${elapsedMs}ms`,
        event.fields()
      );
      throw error;
    }

    const status = c.res.status;
    const elapsedMs = Date.now() - startTime;
    event.set({ http: { method, path, status, ms: elapsedMs } });

    // A procedure records its own refusal, which names the failure kind and the
    // input. Every other route answers with a body, and its wording is the only
    // account of why.
    if (status >= 400 && event.fields().error === undefined) {
      const message = await readRefusalMessage(c.res);
      if (message !== undefined) {
        event.set({ error: { message } });
      }
    }

    const summary = `${method} ${path} ${status} ${elapsedMs}ms`;
    const fields = event.fields();

    if (status >= 500) {
      httpLogger.error(summary, fields);
    } else if (status >= 400) {
      httpLogger.warn(summary, fields);
    } else if (procedure !== null && POLLED_RPC_PROCEDURES.has(procedure)) {
      httpLogger.trace(summary, fields);
    } else {
      httpLogger.info(summary, fields);
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
        context: {
          headers: c.req.raw.headers,
          runtime,
          requestEvent: c.get("wfgraphRequestEvent"),
        },
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
    .get("/extensions", async (c) => {
      const [extensions, agent] = await runtime.runPromise(
        Effect.all([Extensions, AgentConfig])
      );
      return c.json({
        catalog: extensions.catalog,
        agent: { enabled: agent.enabled },
      });
    })
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
