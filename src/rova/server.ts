import path from "node:path";
import { serve } from "bun";
import { createApiApp } from "@/backend/app";
import {
  configureDatabaseRuntime,
  type DatabaseRuntimeConfig,
} from "@/backend/lib/db";
import {
  type MigrationsRuntimeOptions,
  runMigrations,
} from "@/backend/lib/db/migrations";
import {
  configureInngestClient,
  configureInngestServe,
  type InngestClientRuntimeConfig,
  type InngestServeRuntimeConfig,
} from "@/backend/lib/inngest/client";
import { configureAppLogging, getAppLogger } from "@/backend/lib/logger";
import { initializeWorkflowTriggers } from "@/backend/lib/workflow-trigger-bootstrap";
import {
  type RuntimeExtensionActionDefinition,
  registerRuntimeAction,
  unregisterRuntimeAction,
} from "@/shared/workflow/action-registry";
import {
  type RuntimeExtensionTriggerDefinition,
  registerWorkflowTrigger,
  unregisterWorkflowTrigger,
} from "@/shared/workflow/trigger-registry";

type RovaLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

export type RovaServerStartOptions = {
  port?: number;
  logger?: RovaLogger;
  configureLogging?: boolean;
  database: DatabaseRuntimeConfig;
  migrations?: Omit<MigrationsRuntimeOptions, "runOnStartup"> & {
    runOnStartup?: boolean;
  };
  inngest: {
    client: InngestClientRuntimeConfig;
    serve?: InngestServeRuntimeConfig;
  };
  triggers?: RuntimeExtensionTriggerDefinition[];
  actions?: RuntimeExtensionActionDefinition[];
  installSignalHandlers?: boolean;
};

export type RovaServerHandle = {
  url: URL;
  port: number;
  stop: () => Promise<void>;
};

type RovaServerRuntimeState = {
  activeHandle: RovaServerHandle | null;
  activeKey: string | null;
  starting: Promise<RovaServerHandle> | null;
  runtimeTriggerTypes: Set<string>;
  runtimeActionIds: Set<string>;
};

declare global {
  var __rovaServerRuntimeState: RovaServerRuntimeState | undefined;
}

const rovaServerRuntimeState: RovaServerRuntimeState =
  globalThis.__rovaServerRuntimeState
    ? {
        ...globalThis.__rovaServerRuntimeState,
        runtimeTriggerTypes:
          globalThis.__rovaServerRuntimeState.runtimeTriggerTypes ??
          new Set<string>(),
        runtimeActionIds:
          globalThis.__rovaServerRuntimeState.runtimeActionIds ??
          new Set<string>(),
      }
    : {
        activeHandle: null,
        activeKey: null,
        starting: null,
        runtimeTriggerTypes: new Set<string>(),
        runtimeActionIds: new Set<string>(),
      };

globalThis.__rovaServerRuntimeState = rovaServerRuntimeState;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

const DEFAULT_CLIENT_DIST_DIR = "dist/client";
const CLIENT_ENTRY_FILE = "index.html";

function getClientDistDir(): string {
  const configuredDir = Bun.env.CLIENT_DIST_DIR?.trim();
  return configuredDir && configuredDir.length > 0
    ? configuredDir
    : DEFAULT_CLIENT_DIST_DIR;
}

function isSpaPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/workflows" ||
    pathname.startsWith("/workflows/")
  );
}

function resolveClientAssetPath(pathname: string): string | null {
  if (pathname === "/") {
    return null;
  }

  let decodedPath = pathname;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath.startsWith("/")
    ? decodedPath.slice(1)
    : decodedPath;
  if (!relativePath) {
    return null;
  }

  const normalizedPath = path.posix.normalize(relativePath);
  if (
    normalizedPath === "." ||
    normalizedPath.startsWith("../") ||
    normalizedPath.includes("/../")
  ) {
    return null;
  }

  return path.join(getClientDistDir(), normalizedPath);
}

async function serveClientEntry(logger: RovaLogger): Promise<Response> {
  const entryFilePath = path.join(getClientDistDir(), CLIENT_ENTRY_FILE);
  const entryFile = Bun.file(entryFilePath);

  if (await entryFile.exists()) {
    return new Response(entryFile, {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    });
  }

  logger.error("Client bundle entrypoint is missing", {
    entryFilePath,
  });

  return Response.json(
    {
      error: "Client bundle not found. Run `bun run build:client`.",
    },
    { status: 503 }
  );
}

function resolveLogger(logger: RovaLogger | undefined): RovaLogger {
  if (logger) {
    return logger;
  }

  const appLogger = getAppLogger("server");
  const toMessage = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof Error) {
      return value.message;
    }
    if (value === undefined) {
      return "";
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return `${value}`;
    }
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "symbol") {
      return value.description ?? "symbol";
    }
    if (Array.isArray(value) || isRecord(value)) {
      try {
        return JSON.stringify(value);
      } catch {
        return "[unserializable]";
      }
    }
    return "";
  };
  const toProperties = (
    value: unknown,
    rest: unknown[]
  ): Record<string, unknown> | undefined => {
    if (isRecord(value)) {
      if (rest.length === 0) {
        return value;
      }
      return { ...value, extra: rest };
    }

    if (value === undefined && rest.length === 0) {
      return;
    }

    return {
      details:
        value === undefined && rest.length === 1 ? rest[0] : [value, ...rest],
    };
  };
  const forward = (
    method: (message: string, properties?: Record<string, unknown>) => void,
    args: unknown[]
  ) => {
    const [messageValue, propertiesValue, ...rest] = args;
    const properties = toProperties(propertiesValue, rest);
    if (properties) {
      method(toMessage(messageValue), properties);
      return;
    }
    method(toMessage(messageValue));
  };

  const resolved: RovaLogger = {
    info: (...args) => {
      forward(appLogger.info.bind(appLogger), args);
    },
    warn: (...args) => {
      forward(appLogger.warn.bind(appLogger), args);
    },
    error: (...args) => {
      forward(appLogger.error.bind(appLogger), args);
    },
  };

  if (typeof appLogger.debug === "function") {
    resolved.debug = (...args) => {
      forward(appLogger.debug.bind(appLogger), args);
    };
  }

  return resolved;
}

function registerRuntimeExtensions(options: RovaServerStartOptions): void {
  for (const triggerType of rovaServerRuntimeState.runtimeTriggerTypes) {
    unregisterWorkflowTrigger(triggerType);
  }
  rovaServerRuntimeState.runtimeTriggerTypes.clear();

  for (const actionId of rovaServerRuntimeState.runtimeActionIds) {
    unregisterRuntimeAction(actionId);
  }
  rovaServerRuntimeState.runtimeActionIds.clear();

  for (const trigger of options.triggers ?? []) {
    registerWorkflowTrigger(trigger);
    rovaServerRuntimeState.runtimeTriggerTypes.add(trigger.runtime.type.trim());
  }

  for (const action of options.actions ?? []) {
    registerRuntimeAction(action);
    rovaServerRuntimeState.runtimeActionIds.add(action.id.trim());
  }
}

function assertRequiredConfig(options: RovaServerStartOptions): void {
  if (!options.database.url?.trim()) {
    throw new Error("server.start requires database.url");
  }

  if (!options.inngest.client.id?.trim()) {
    throw new Error("server.start requires inngest.client.id");
  }
}

function getResolvedPort(options: RovaServerStartOptions): number {
  return options.port ?? Number(Bun.env.PORT ?? 4017);
}

function createRuntimeKey(options: RovaServerStartOptions): string {
  return JSON.stringify({
    port: getResolvedPort(options),
    databaseUrl: options.database.url,
    inngestClientId: options.inngest.client.id,
    inngestBaseUrl: options.inngest.client.baseUrl,
    runMigrations: options.migrations?.runOnStartup === true,
  });
}

export async function startRovaServer(
  options: RovaServerStartOptions
): Promise<RovaServerHandle> {
  assertRequiredConfig(options);

  const runtimeKey = createRuntimeKey(options);

  if (
    rovaServerRuntimeState.activeHandle &&
    rovaServerRuntimeState.activeKey === runtimeKey
  ) {
    return rovaServerRuntimeState.activeHandle;
  }

  if (
    rovaServerRuntimeState.starting &&
    rovaServerRuntimeState.activeKey === runtimeKey
  ) {
    return await rovaServerRuntimeState.starting;
  }

  if (rovaServerRuntimeState.activeHandle) {
    throw new Error(
      "Rova server is already running with a different configuration. Stop the current server before starting a new one."
    );
  }

  const startupPromise = (async (): Promise<RovaServerHandle> => {
    if (options.configureLogging !== false) {
      configureAppLogging();
    }

    const logger = resolveLogger(options.logger);

    configureDatabaseRuntime(options.database);
    configureInngestClient(options.inngest.client);
    configureInngestServe(options.inngest.serve);

    registerRuntimeExtensions(options);
    initializeWorkflowTriggers();

    await runMigrations({
      runOnStartup: options.migrations?.runOnStartup === true,
      migrationsDir: options.migrations?.migrationsDir,
    });

    const apiApp = createApiApp();
    const port = getResolvedPort(options);
    const bunServer = serve({
      port,
      development: Bun.env.NODE_ENV !== "production",
      fetch: async (req) => {
        const url = new URL(req.url);
        const pathname = normalizePath(url.pathname);

        if (pathname.startsWith("/api/")) {
          return apiApp.fetch(req);
        }

        const clientAssetPath = resolveClientAssetPath(pathname);
        if (clientAssetPath) {
          const assetFile = Bun.file(clientAssetPath);
          if (await assetFile.exists()) {
            return new Response(assetFile);
          }
        }

        if (isSpaPath(pathname)) {
          return await serveClientEntry(logger);
        }

        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) {
        return;
      }

      stopping = true;

      try {
        await bunServer.stop(true);
      } catch (error) {
        logger.error("Failed to stop Bun server", { error });
      }
    };

    const signalHandlers = new Map<string, () => Promise<void>>();
    if (options.installSignalHandlers !== false) {
      const signals = ["SIGINT", "SIGTERM"] as const;
      for (const signal of signals) {
        const handler = async () => {
          logger.warn("Received shutdown signal", { signal });
          try {
            await stop();
          } catch (error) {
            logger.error("Failed to stop server after signal", {
              error,
              signal,
            });
          }
        };
        signalHandlers.set(signal, handler);
        process.on(signal, handler);
      }
    }

    logger.info("Server listening", { url: bunServer.url, port });

    const handle: RovaServerHandle = {
      url: bunServer.url,
      port,
      stop: async () => {
        for (const [signal, handler] of signalHandlers.entries()) {
          process.off(signal, handler);
        }
        signalHandlers.clear();
        await stop();
        for (const triggerType of rovaServerRuntimeState.runtimeTriggerTypes) {
          unregisterWorkflowTrigger(triggerType);
        }
        rovaServerRuntimeState.runtimeTriggerTypes.clear();
        for (const actionId of rovaServerRuntimeState.runtimeActionIds) {
          unregisterRuntimeAction(actionId);
        }
        rovaServerRuntimeState.runtimeActionIds.clear();

        if (rovaServerRuntimeState.activeHandle === handle) {
          rovaServerRuntimeState.activeHandle = null;
          rovaServerRuntimeState.activeKey = null;
        }
      },
    };

    rovaServerRuntimeState.activeHandle = handle;
    rovaServerRuntimeState.activeKey = runtimeKey;

    return handle;
  })();

  rovaServerRuntimeState.starting = startupPromise;
  rovaServerRuntimeState.activeKey = runtimeKey;

  try {
    return await startupPromise;
  } catch (error) {
    if (rovaServerRuntimeState.starting === startupPromise) {
      rovaServerRuntimeState.starting = null;
      if (!rovaServerRuntimeState.activeHandle) {
        rovaServerRuntimeState.activeKey = null;
      }
    }
    throw error;
  } finally {
    if (rovaServerRuntimeState.starting === startupPromise) {
      rovaServerRuntimeState.starting = null;
    }
  }
}

export const server: {
  start: typeof startRovaServer;
} = {
  start: startRovaServer,
};
