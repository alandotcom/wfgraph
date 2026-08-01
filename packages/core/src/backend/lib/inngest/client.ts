import { Inngest } from "inngest";
import { serve as serveInngest } from "inngest/hono";
import { buildInngestFunctions } from "#src/backend/lib/inngest/functions";
import type { BaseMiddleware } from "#src/backend/extensions/middleware";
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
    // Cloud mode is what makes the SDK verify a callback signature at all, so a
    // host opts into the unsigned dev loop by hand and nothing infers it for
    // them. Passing the option through undefined leaves the SDK's own
    // `INNGEST_DEV` fallback reachable, which is the only other way in.
    isDev: config.isDev,
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
 * callbacks. The SDK's own gate is the resolved mode: it returns success from
 * `validateSignature` without a check whenever the client is not in cloud mode,
 * so dev mode leaves an anonymous POST able to execute a workflow function with
 * a graph and a payload of its choosing. This reads that same resolved value off
 * the client rather than re-deriving it, so the warning and the gate cannot
 * disagree.
 *
 * A log rather than a refusal, because local development legitimately runs
 * unsigned against `inngest dev`.
 */
function reportInngestCallbackExposure(
  mode: Inngest["mode"],
  signingKey: string | undefined
): void {
  const logger = getAppLogger("inngest");

  if (mode === "dev") {
    logger.error(
      "The Inngest callback at /api/inngest is unsigned: the client is in dev mode, where the SDK verifies no signature, so the route will execute a request from anyone who can reach it. Leave inngest.isDev unset, and INNGEST_DEV out of the environment, for any deployment that is not a local dev loop."
    );
    return;
  }

  if (typeof signingKey === "string" && signingKey.trim()) {
    return;
  }

  logger.error(
    "The Inngest callback at /api/inngest has no signing key: in cloud mode the SDK refuses every callback it cannot verify, so no function will run. Set inngest.signingKey or INNGEST_SIGNING_KEY."
  );
}

/** What `serve()` answers a callback with. */
export type InngestServeHandler = ReturnType<typeof serveInngest>;

/**
 * Everything one app does with Inngest, as one value.
 *
 * The connection and the handler that serves this app's functions have to
 * agree: functions registered on one client and served through another are
 * invisible to Inngest. Building both together is what makes the disagreement
 * inexpressible -- `createRovaApp` builds one surface and hands the same value
 * to the Layer graph and to the API app.
 */
export type InngestSurface = {
  /** The connection every send and every registered function is made on. */
  client: Inngest;
  /**
   * Builds the `/inngest` handler for this app's functions.
   *
   * The runtime is a parameter because the functions in that list run services
   * on it. Called once, at boot, so a build failure surfaces there rather than
   * on the first Inngest callback.
   */
  serve: (runtime: RovaRuntime) => Promise<InngestServeHandler>;
};

export function createInngestSurface(
  config: RovaInngestConfig,
  middleware: readonly BaseMiddleware[] = []
): InngestSurface {
  const signingKey = config.signingKey ?? process.env.INNGEST_SIGNING_KEY;
  const client = createInngestClient(config, signingKey);
  reportInngestCallbackExposure(client.mode, signingKey);

  return {
    client,
    serve: async (runtime) =>
      serveInngest({
        client,
        functions: await buildInngestFunctions(client, runtime, middleware),
        // As of v4 the signing keys and base URL live on the client, so what
        // is left for `serve()` is where Inngest should call back.
        serveOrigin: config.serveOrigin,
        servePath: config.servePath,
      }),
  };
}
