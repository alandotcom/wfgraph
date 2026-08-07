/**
 * Mounting Workflow Graph inside a host that speaks Node's `http` module.
 *
 * `createWfGraphApp` hands back a fetch handler, which Bun, Deno, and Cloudflare
 * Workers consume as-is. Express and Fastify sit on `node:http`, whose currency
 * is `IncomingMessage`/`ServerResponse`, so they need one translation step. That
 * step lives here rather than in a README recipe, because a Node mount has three
 * ways to go wrong that a host cannot reasonably be asked to know about, and all
 * three are handled below.
 *
 * HTTP/1.1 only. Detecting a drained request body relies on `content-length` or
 * `transfer-encoding`, and HTTP/2 requires neither.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { WfGraphApp } from "#src/app";
import { getAppLogger } from "#src/backend/lib/logger";
import { getErrorMessage } from "@wfgraph/shared/utils";

const nodeLogger = getAppLogger("http", "node");

const CONSUMED_BODY_MESSAGE =
  "Workflow Graph received a request whose body another middleware had already read. " +
  "Mount Workflow Graph before your body parser, or exclude Workflow Graph's path from it " +
  '(for example `app.use("/wfgraph", wfgraphListener)` above `app.use(express.json())`). ' +
  "Workflow Graph cannot re-create the original bytes, and the Inngest callback verifies a " +
  "signature over them.";

function buildMountMismatchMessage(
  hostPrefix: string,
  basePath: string
): string {
  return (
    `Workflow Graph is mounted at "${hostPrefix || "/"}" but was configured with basePath "${basePath || "/"}". ` +
    "Every request under this mount answers 404 until the two agree. Pass the same path to " +
    "the host's mount call and to createWfGraphApp's basePath option."
  );
}

/**
 * Express rewrites `req.url` to strip the path it matched on, so a listener
 * mounted with `app.use("/wfgraph", ...)` sees "/api/extensions" where the client
 * asked for "/wfgraph/api/extensions". `req.originalUrl` is the only place the
 * full path survives, and Workflow Graph routes on the full path because the host told it
 * where the mount is. `@fastify/middie` sets the same property, and a bare
 * `http.createServer` sets neither, leaving `req.url` already complete.
 */
type MountedIncomingMessage = IncomingMessage & { originalUrl?: string };

function hasRequestBody(request: IncomingMessage): boolean {
  if (request.headers["transfer-encoding"] !== undefined) {
    return true;
  }
  const contentLength = Number(request.headers["content-length"] ?? "0");
  return Number.isFinite(contentLength) && contentLength > 0;
}

/**
 * True when a body arrived on the wire but the stream has already been drained.
 *
 * A body parser mounted ahead of Workflow Graph leaves exactly this state, and every POST
 * would otherwise reach Workflow Graph empty: a wait resume would see `{}` and the Inngest
 * callback's signature check would fail on bytes that no longer exist.
 * Re-serializing a parsed body is not a way out, because `JSON.stringify` does
 * not reproduce the original bytes and the signature covers those.
 *
 * The `content-length` test is what keeps a legitimate bodyless POST from
 * tripping this: such a request is drained too, but has nothing to lose.
 */
function isRequestBodyConsumed(request: IncomingMessage): boolean {
  return hasRequestBody(request) && request.readableEnded;
}

export type CreateRequestListenerOptions = {
  /**
   * Hostname to assume when a request carries no Host header, which is legal in
   * HTTP/1.0. Workflow Graph only needs it to build a `Request` URL; nothing routes on it.
   */
  hostname?: string;
};

export type WfGraphRequestListener = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>;

/**
 * Turn a Workflow Graph app into a Node request listener.
 *
 * Hand the result to `http.createServer`, to `app.use(path, listener)` in
 * Express, or to the same call in Fastify once `@fastify/middie` is registered.
 * Whatever path the host mounts it at has to be the one passed to
 * `createWfGraphApp` as `basePath`. Node 20 or newer, which is what the underlying
 * adapter requires.
 */
export function createRequestListener(
  wfgraph: WfGraphApp,
  options: CreateRequestListenerOptions = {}
): WfGraphRequestListener {
  const listener = getRequestListener(wfgraph.fetch, {
    hostname: options.hostname,
    // A library has no business swapping the host application's global Request
    // and Response constructors, which this adapter does by default.
    overrideGlobalObjects: false,
    // Without this the adapter answers 500 with an empty body and says nothing,
    // which turns a bug inside Workflow Graph into a mystery for whoever mounted it.
    errorHandler: (error) => {
      nodeLogger.error(
        `Unhandled error serving a Workflow Graph request: ${getErrorMessage(error)}`,
        {
          error,
        }
      );
      return Response.json({ error: "Internal Server Error" }, { status: 500 });
    },
  });

  // The mount-point warning fires once. A mismatch is a startup mistake, so
  // repeating it per request would bury the rest of the host's log.
  let mountMismatchReported = false;

  return async (request, response) => {
    const mounted: MountedIncomingMessage = request;

    if (isRequestBodyConsumed(request)) {
      nodeLogger.error(CONSUMED_BODY_MESSAGE, {
        method: request.method,
        path: mounted.originalUrl ?? request.url,
      });
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: CONSUMED_BODY_MESSAGE }));
      return;
    }

    // Restore the path the client actually asked for. Mutating `url` is how the
    // underlying adapter is told about it; the change is confined to this
    // request and to the part of the pipeline Workflow Graph owns, since this listener
    // always answers rather than calling next().
    if (mounted.originalUrl !== undefined) {
      // What the host stripped off is where the host thinks Workflow Graph is mounted.
      // Comparing it to what Workflow Graph was told catches the mount call and the
      // basePath option naming different paths, in either direction, which
      // otherwise shows up as a uniform 404 with nothing to explain it.
      const hostPrefix = mounted.originalUrl.slice(
        0,
        mounted.originalUrl.length - (request.url?.length ?? 0)
      );
      if (!mountMismatchReported && hostPrefix !== wfgraph.basePath) {
        mountMismatchReported = true;
        nodeLogger.error(
          buildMountMismatchMessage(hostPrefix, wfgraph.basePath)
        );
      }

      request.url = mounted.originalUrl;
    }

    await listener(request, response);
  };
}
