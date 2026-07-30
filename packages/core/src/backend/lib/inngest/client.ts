import { Inngest, type InngestFunction } from "inngest";
import { serve as serveInngest } from "inngest/hono";
import { createInngestFunctionRegistry } from "#src/backend/lib/inngest/functions";
import { getAppLogger } from "#src/backend/lib/logger";
import type { RovaRuntime } from "#src/backend/runtime";

function getInngestBaseUrl() {
  const candidates = [process.env.INNGEST_BASE_URL, process.env.INNGEST_DEV];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (URL.canParse(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Everything a host says about Inngest, in one object.
 *
 * Written out by hand rather than derived from the SDK's own option types, so
 * `@rova/core`'s published surface stops moving whenever Inngest changes its
 * constructor. The split between what the client takes and what `serve()` takes
 * is Inngest's business and is applied below, not something a host restates.
 */
export type RovaInngestConfig = {
  id: string;
  isDev?: boolean;
  baseUrl?: string;
  eventKey?: string;
  env?: string;
  signingKey?: string;
  signingKeyFallback?: string;
  /** Public origin Inngest should call back on, for example "https://app.example.com". */
  serveOrigin?: string;
  servePath?: string;
};

/**
 * The client this app sends and registers through.
 *
 * One client per app: a second app in the process gets its own, so it cannot
 * send on the first app's connection or register functions against it.
 *
 * The environment fills in what the host left out, because the fields it covers
 * are the ones a platform sets rather than ones a host writes: the dev server's
 * URL, the event key, the signing keys.
 */
function createInngestClient(
  config: RovaInngestConfig,
  signingKey: string | undefined
): Inngest {
  const id = config.id.trim();
  if (!id) {
    throw new Error("Inngest configuration requires a non-empty id.");
  }

  return new Inngest({
    id,
    // v4 runs in cloud mode by default and demands a signing key there, so the
    // dev loop has to say so rather than fall into it.
    isDev: config.isDev ?? process.env.NODE_ENV !== "production",
    baseUrl: config.baseUrl ?? getInngestBaseUrl(),
    eventKey: config.eventKey ?? process.env.INNGEST_EVENT_KEY,
    env: config.env ?? process.env.INNGEST_ENV,
    signingKey,
    signingKeyFallback:
      config.signingKeyFallback ?? process.env.INNGEST_SIGNING_KEY_FALLBACK,
  });
}

/**
 * `/api/inngest` sits outside the host's auth gate because Inngest signs its
 * callbacks. That holds only with a signing key configured; without one the SDK
 * runs in dev mode and skips verification, leaving an anonymous POST able to
 * execute a workflow function with a payload of its choosing.
 *
 * A log rather than a refusal, because local development legitimately runs
 * unsigned against `inngest dev` and the check that would tell them apart is the
 * same environment-variable guess that made the auth option unreliable.
 */
function reportInngestCallbackExposure(signingKey: string | undefined): void {
  if (typeof signingKey === "string" && signingKey.trim()) {
    return;
  }

  getAppLogger("inngest").error(
    "The Inngest callback at /api/inngest is unsigned: no inngest.signingKey is configured, so it will accept and execute a request from anyone who can reach it. Set a signing key for any deployment that is not a local dev loop."
  );
}

/** What `serve()` answers a callback with, named so the cache below can hold one. */
type InngestServeHandler = ReturnType<typeof serveInngest>;

/**
 * Everything one app does with Inngest, as one value.
 *
 * The connection, the function list, and the handler that serves that list have
 * to agree: functions registered on one client and served through another are
 * invisible to Inngest, and a save that invalidates some other app's list leaves
 * this one serving a stale one. Building all three together is what makes the
 * disagreement inexpressible -- `createRovaApp` builds one surface and hands the
 * same value to the Layer graph and to the API app.
 */
export type InngestSurface = {
  /** The connection every send and every registered function is made on. */
  client: Inngest;
  /** Drop the function list, including a build still in flight. */
  invalidate: () => void;
  /**
   * The `/inngest` handler for this app's current function list.
   *
   * The runtime is a parameter because the event listeners in that list run
   * services on it, and the route has the app's own in hand.
   */
  serve: (runtime: RovaRuntime) => Promise<InngestServeHandler>;
};

export function createInngestSurface(
  config: RovaInngestConfig
): InngestSurface {
  const signingKey = config.signingKey ?? process.env.INNGEST_SIGNING_KEY;
  const client = createInngestClient(config, signingKey);
  reportInngestCallbackExposure(signingKey);

  const registry = createInngestFunctionRegistry(client);

  // The serve handler is rebuilt only when the function list changes. Every
  // callback and every sync hits this route, and building a handler means
  // Inngest walking each function to describe it. The list is a stable array
  // while the registry's cache holds, so identity is the whole test.
  let cachedFor: InngestFunction.Any[] | undefined;
  let handler: InngestServeHandler | undefined;

  return {
    client,
    invalidate: registry.invalidate,
    serve: async (runtime) => {
      const functions = await registry.get(runtime);

      if (!handler || cachedFor !== functions) {
        handler = serveInngest({
          client,
          functions,
          // As of v4 the signing keys and base URL live on the client, so what
          // is left for `serve()` is where Inngest should call back.
          serveOrigin: config.serveOrigin,
          servePath: config.servePath,
        });
        cachedFor = functions;
      }

      return handler;
    },
  };
}
