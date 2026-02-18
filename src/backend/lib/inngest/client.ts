import { Inngest } from "inngest";

function getInngestBaseUrl() {
  const candidates = [Bun.env.INNGEST_BASE_URL, Bun.env.INNGEST_DEV];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (URL.canParse(candidate)) {
      return candidate;
    }
  }

  return;
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
    isDev: Bun.env.NODE_ENV !== "production",
    baseUrl: getInngestBaseUrl(),
    eventKey: Bun.env.INNGEST_EVENT_KEY,
    env: Bun.env.INNGEST_ENV,
  };
}

function normalizeClientConfig(
  config: InngestClientRuntimeConfig
): InngestClientRuntimeConfig {
  return {
    ...config,
    id: String(config.id ?? "").trim(),
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

export function getInngestClient(): Inngest {
  if (inngestRuntimeState.client) {
    return inngestRuntimeState.client;
  }

  const config =
    inngestRuntimeState.clientConfig ?? resolveDefaultClientConfig();
  inngestRuntimeState.client = new Inngest(config);
  return inngestRuntimeState.client;
}
