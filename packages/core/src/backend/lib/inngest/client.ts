import { Inngest, type RegisterOptions } from "inngest";
import { getAppLogger } from "@/backend/lib/logger";

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

type InngestRuntimeState = {
  config: RovaInngestConfig | null;
  client: Inngest | null;
};

declare global {
  var __rovaInngestState: InngestRuntimeState | undefined;
}

const inngestRuntimeState: InngestRuntimeState =
  globalThis.__rovaInngestState ?? {
    config: null,
    client: null,
  };

globalThis.__rovaInngestState = inngestRuntimeState;

function resolveDefaultConfig(): RovaInngestConfig {
  return {
    id: "notifications-workflow",
    // v4 runs in cloud mode by default and demands a signing key there, so the
    // dev loop has to say so rather than fall into it.
    isDev: process.env.NODE_ENV !== "production",
    baseUrl: getInngestBaseUrl(),
    eventKey: process.env.INNGEST_EVENT_KEY,
    env: process.env.INNGEST_ENV,
    signingKey: process.env.INNGEST_SIGNING_KEY,
    signingKeyFallback: process.env.INNGEST_SIGNING_KEY_FALLBACK,
  };
}

function normalizeConfig(config: RovaInngestConfig): RovaInngestConfig {
  return {
    ...config,
    id: (config.id ?? "").trim(),
  };
}

/**
 * Whether a second `configureInngest` call describes the client that is already
 * running. Covers only the fields that reach the constructor, since the serve
 * fields are read per request and can change freely.
 */
function areConfigsCompatible(
  current: RovaInngestConfig,
  next: RovaInngestConfig
): boolean {
  return (
    current.id === next.id &&
    current.baseUrl === next.baseUrl &&
    current.eventKey === next.eventKey &&
    current.env === next.env &&
    current.isDev === next.isDev &&
    current.signingKey === next.signingKey &&
    current.signingKeyFallback === next.signingKeyFallback
  );
}

export function configureInngest(config: RovaInngestConfig): void {
  const normalizedConfig = normalizeConfig(config);

  if (!normalizedConfig.id) {
    throw new Error("Inngest configuration requires a non-empty id.");
  }

  if (inngestRuntimeState.client) {
    const currentConfig = inngestRuntimeState.config ?? resolveDefaultConfig();

    if (areConfigsCompatible(currentConfig, normalizedConfig)) {
      inngestRuntimeState.config = normalizedConfig;
      return;
    }

    throw new Error(
      "Inngest client is already initialized with a different configuration. Restart the process to apply a new Inngest config."
    );
  }

  inngestRuntimeState.config = normalizedConfig;
}

function getConfig(): RovaInngestConfig {
  return inngestRuntimeState.config ?? resolveDefaultConfig();
}

/**
 * The subset `serve()` still takes. As of v4 the signing keys and base URL live
 * on the client, so this is only the two things that describe where Inngest
 * should call back.
 */
export function getInngestServeConfig(): Pick<
  RegisterOptions,
  "serveOrigin" | "servePath"
> {
  const { serveOrigin, servePath } = getConfig();
  return { serveOrigin, servePath };
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
export function reportInngestCallbackExposure(): void {
  const { signingKey } = getConfig();
  if (typeof signingKey === "string" && signingKey.trim()) {
    return;
  }

  getAppLogger("inngest").error(
    "The Inngest callback at /api/inngest is unsigned: no inngest.signingKey is configured, so it will accept and execute a request from anyone who can reach it. Set a signing key for any deployment that is not a local dev loop."
  );
}

export function getInngestClient(): Inngest {
  if (inngestRuntimeState.client) {
    return inngestRuntimeState.client;
  }

  const {
    serveOrigin: _serveOrigin,
    servePath: _servePath,
    ...clientConfig
  } = getConfig();
  inngestRuntimeState.client = new Inngest(clientConfig);
  return inngestRuntimeState.client;
}
