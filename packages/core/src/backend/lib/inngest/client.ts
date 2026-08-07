import type { InngestFunction } from "inngest";
import { Inngest } from "inngest";
import {
  connect as connectInngest,
  type WorkerConnection,
} from "inngest/connect";
import { serve as serveInngest } from "inngest/hono";
import { getAppLogger } from "#src/backend/lib/logger";

export type { WorkerConnection } from "inngest/connect";

/**
 * Bound on the Connect handshake at boot, absent `inngest.connectTimeoutMs`.
 *
 * Read against the installed `inngest@4.14.0` source
 * (`components/connect/strategies/core/connection.js`): every handshake
 * failure surfaces as a `ReconnectError`, and the reconcile loop's `while
 * (true)` retries each one with exponential backoff forever, never settling
 * the promise `connect()` hands back. An unreachable gateway would otherwise
 * hang `createWfGraphApp` with nothing logged. Thirty seconds covers a slow but
 * live gateway; a wedged one gets caught well inside a typical platform
 * startup-probe window instead of past it.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Races an in-flight Connect handshake against a bound, so a gateway that
 * never settles fails boot instead of hanging it. The SDK gives no way to
 * cancel `connecting` once the timer wins, so its reconcile loop keeps
 * retrying in the background. If it later succeeds, the `WorkerConnection`
 * it hands back is already registered with the gateway (WORKER_READY sent)
 * with nothing holding it: `createWfGraphApp` rejected on the timeout and tore
 * its runtime and database pool down. Resolving the outer promise at that
 * point would be a no-op, since it already settled, so a late arrival is
 * closed instead, and left alone otherwise.
 */
function withConnectTimeout(
  connecting: Promise<WorkerConnection>,
  timeoutMs: number,
  gatewayLabel: string
): Promise<WorkerConnection> {
  let timedOut = false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(
          `Inngest Connect could not reach ${gatewayLabel} within ${timeoutMs}ms and gave up. A gateway that never completes the handshake would otherwise retry forever without failing boot. Confirm the gateway is running and reachable, or raise inngest.connectTimeoutMs if it is only slow.`
        )
      );
    }, timeoutMs);

    connecting.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) {
          // Boot already rejected on this handshake; tear the now-orphaned
          // connection back down rather than leave it receiving executions
          // that would run against a disposed runtime. `close()` rejecting
          // here must not become an unhandled rejection on top of a boot
          // that has already failed for its own, already-reported reason.
          value.close().catch((closeError: unknown) => {
            getAppLogger("inngest").warn(
              `Inngest Connect handshake succeeded after boot had already given up on it, and closing the abandoned worker connection failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`
            );
          });
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

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
 * `@wfgraph/core`'s published surface stops moving whenever Inngest changes its
 * constructor. The split between what the client takes and what `serve()` /
 * `connect()` take is Inngest's business and is applied below, not something a
 * host restates.
 */
export type WfGraphInngestConfig = {
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
  /**
   * Open a Connect WebSocket at boot so Inngest can push executions to this
   * process. Long-running hosts set this; the app dials out and mounts no
   * `/api/inngest` callback. Serverless hosts leave it unset and keep HTTP
   * serve, which Inngest must be able to reach.
   */
  connect?: boolean;
  /**
   * Stable id for this Connect worker. Defaults to the machine hostname when
   * absent. Used only when `connect` is true.
   */
  instanceId?: string;
  /**
   * WebSocket gateway URL for Connect, for example
   * `ws://localhost:8390/v0/connect`. The SDK also reads
   * `INNGEST_CONNECT_GATEWAY_URL`. Used only when `connect` is true.
   */
  gatewayUrl?: string;
  /**
   * Cap on concurrent step executions on this Connect worker. Used only when
   * `connect` is true.
   */
  maxWorkerConcurrency?: number;
  /**
   * Milliseconds `createWfGraphApp` waits for the Connect handshake to reach an
   * active connection before failing boot. Defaults to 30 seconds. Used only
   * when `connect` is true.
   */
  connectTimeoutMs?: number;
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
  config: WfGraphInngestConfig,
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
 * unsigned against `inngest dev`. Connect mode mounts no callback route, so
 * this report is skipped there.
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

/**
 * Connect authenticates the worker to the gateway with the signing key. Dev
 * mode against `inngest dev` needs none; cloud mode without a key will fail the
 * handshake rather than run unsigned.
 */
function reportInngestConnectCredentials(
  mode: Inngest["mode"],
  signingKey: string | undefined
): void {
  if (mode === "dev") {
    return;
  }

  if (typeof signingKey === "string" && signingKey.trim()) {
    return;
  }

  getAppLogger("inngest").error(
    "Inngest Connect has no signing key: in cloud mode the worker cannot authenticate to the gateway, so no function will run. Set inngest.signingKey or INNGEST_SIGNING_KEY."
  );
}

/** What `serve()` answers a callback with. */
export type InngestServeHandler = ReturnType<typeof serveInngest>;

/**
 * Everything one app does with Inngest, as one value.
 *
 * HTTP serve and Connect are alternatives: a host picks one registration path
 * per app. Building the function list once in `createWfGraphApp` and handing that
 * same array to whichever path is chosen is what keeps the registered surface
 * and the client the same app's.
 */
export type InngestSurface = {
  /** The connection every send and every registered function is made on. */
  client: Inngest;
  /**
   * Builds the `/inngest` handler for a function list already built for this
   * client. Synchronous: the caller owns the build so the list cannot drift
   * from what Connect would have registered on the other path.
   */
  serve: (functions: InngestFunction.Any[]) => InngestServeHandler;
  /**
   * Opens a Connect WebSocket for a function list already built for this
   * client. Shutdown signals are left to the host: Workflow Graph closes the returned
   * connection from `dispose`. Rejects once `connectTimeoutMs` elapses
   * without an active connection, naming the gateway it could not reach.
   */
  connect: (functions: InngestFunction.Any[]) => Promise<WorkerConnection>;
};

export function createInngestSurface(
  config: WfGraphInngestConfig
): InngestSurface {
  const signingKey = config.signingKey ?? process.env.INNGEST_SIGNING_KEY;
  const client = createInngestClient(config, signingKey);
  if (config.connect === true) {
    reportInngestConnectCredentials(client.mode, signingKey);
  } else {
    reportInngestCallbackExposure(client.mode, signingKey);
  }

  return {
    client,
    serve: (functions) =>
      serveInngest({
        client,
        functions,
        // As of v4 the signing keys and base URL live on the client, so what
        // is left for `serve()` is where Inngest should call back.
        serveOrigin: config.serveOrigin,
        servePath: config.servePath,
      }),
    connect: (functions) =>
      withConnectTimeout(
        connectInngest({
          apps: [{ client, functions }],
          instanceId: config.instanceId,
          gatewayUrl: config.gatewayUrl,
          maxWorkerConcurrency: config.maxWorkerConcurrency,
          // The host owns SIGINT/SIGTERM (and `dispose`); leaving the SDK's
          // default handlers in place races a second close against that path.
          handleShutdownSignals: [],
        }),
        config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        // An explicit gatewayUrl, ours or the SDK's own INNGEST_CONNECT_GATEWAY_URL
        // fallback, is what actually gets dialed. Absent both, the SDK asks the
        // Inngest API for a gateway on every attempt, so naming that API is the
        // closest true statement available here.
        config.gatewayUrl ??
          process.env.INNGEST_CONNECT_GATEWAY_URL ??
          `the gateway ${client.apiBaseUrl} assigns`
      ),
  };
}
