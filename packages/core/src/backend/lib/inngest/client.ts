import { Inngest } from "inngest";
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

export type InngestClientRuntimeConfig = ConstructorParameters<
  typeof Inngest
>[0];

export type InngestServeRuntimeConfig = Record<string, unknown>;

type InngestRuntimeState = {
  clientConfig: InngestClientRuntimeConfig | null;
  serveConfig: InngestServeRuntimeConfig;
  client: Inngest | null;
};

declare global {
  var __rovaInngestState: InngestRuntimeState | undefined;
}

const inngestRuntimeState: InngestRuntimeState =
  globalThis.__rovaInngestState ?? {
    clientConfig: null,
    serveConfig: {},
    client: null,
  };

globalThis.__rovaInngestState = inngestRuntimeState;

function resolveDefaultClientConfig(): InngestClientRuntimeConfig {
  return {
    id: "notifications-workflow",
    isDev: process.env.NODE_ENV !== "production",
    baseUrl: getInngestBaseUrl(),
    eventKey: process.env.INNGEST_EVENT_KEY,
    env: process.env.INNGEST_ENV,
  };
}

function normalizeClientConfig(
  config: InngestClientRuntimeConfig
): InngestClientRuntimeConfig {
  return {
    ...config,
    id: (config.id ?? "").trim(),
  };
}

function areClientConfigsCompatible(
  current: InngestClientRuntimeConfig,
  next: InngestClientRuntimeConfig
): boolean {
  return (
    current.id === next.id &&
    current.baseUrl === next.baseUrl &&
    current.eventKey === next.eventKey &&
    current.env === next.env &&
    current.isDev === next.isDev
  );
}

export function configureInngestClient(
  config: InngestClientRuntimeConfig
): void {
  const normalizedConfig = normalizeClientConfig(config);

  if (!normalizedConfig.id) {
    throw new Error("Inngest client configuration requires a non-empty id.");
  }

  if (inngestRuntimeState.client) {
    const currentConfig =
      inngestRuntimeState.clientConfig ?? resolveDefaultClientConfig();

    if (areClientConfigsCompatible(currentConfig, normalizedConfig)) {
      return;
    }

    throw new Error(
      "Inngest client is already initialized with a different configuration. Restart the process to apply a new Inngest client config."
    );
  }

  inngestRuntimeState.clientConfig = normalizedConfig;
}

export function configureInngestServe(
  config: InngestServeRuntimeConfig | undefined
): void {
  inngestRuntimeState.serveConfig = config ?? {};
}

export function getInngestServeConfig(): InngestServeRuntimeConfig {
  return inngestRuntimeState.serveConfig;
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
  const signingKey = inngestRuntimeState.serveConfig.signingKey;
  if (typeof signingKey === "string" && signingKey.trim()) {
    return;
  }

  getAppLogger("inngest").error(
    "The Inngest callback at /api/inngest is unsigned: no inngest.serve.signingKey is configured, so it will accept and execute a request from anyone who can reach it. Set a signing key for any deployment that is not a local dev loop."
  );
}

export function getInngestClient(): Inngest {
  if (inngestRuntimeState.client) {
    return inngestRuntimeState.client;
  }

  const config =
    inngestRuntimeState.clientConfig ?? resolveDefaultClientConfig();
  inngestRuntimeState.client = new Inngest(config);
  return inngestRuntimeState.client;
}
