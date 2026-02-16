import { Inngest } from "inngest";

function getInngestBaseUrl() {
  const candidates = [Bun.env.INNGEST_BASE_URL, Bun.env.INNGEST_DEV];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      new URL(candidate);
      return candidate;
    } catch {
      // Ignore non-URL values such as INNGEST_DEV=1.
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

const globalForInngest = globalThis as unknown as {
  __rovaInngestState?: InngestRuntimeState;
};

const inngestRuntimeState: InngestRuntimeState =
  globalForInngest.__rovaInngestState ?? {
    clientConfig: null,
    serveConfig: {},
    client: null,
  };

globalForInngest.__rovaInngestState = inngestRuntimeState;

function resolveDefaultClientConfig(): InngestClientRuntimeConfig {
  return {
    id: "notifications-workflow",
    isDev: Bun.env.NODE_ENV !== "production",
    baseUrl: getInngestBaseUrl(),
    eventKey: Bun.env.INNGEST_EVENT_KEY,
    env: Bun.env.INNGEST_ENV,
  };
}

function assertClientConfigurable(): void {
  if (inngestRuntimeState.client) {
    throw new Error(
      "Inngest client is already initialized. Call configureInngestClient(...) before first use."
    );
  }
}

export function configureInngestClient(
  config: InngestClientRuntimeConfig
): void {
  if (!(config.id && String(config.id).trim())) {
    throw new Error("Inngest client configuration requires a non-empty id.");
  }

  assertClientConfigurable();
  inngestRuntimeState.clientConfig = config;
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
