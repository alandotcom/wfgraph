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
import {
  type InngestDevServerConfig,
  startInngestDevServer,
  stopInngestDevServer,
} from "@/backend/lib/inngest/dev-server";
import { configureAppLogging, getAppLogger } from "@/backend/lib/logger";
import { initializeWorkflowTriggers } from "@/backend/lib/workflow-trigger-bootstrap";
import appHtml from "@/client/index.html";
import {
  type RuntimeActionDefinition,
  registerRuntimeAction,
} from "@/shared/workflow/action-registry";
import {
  registerWorkflowTrigger,
  type WorkflowTriggerDefinition,
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
    devServer?: InngestDevServerConfig;
  };
  triggers?: WorkflowTriggerDefinition[];
  actions?: RuntimeActionDefinition[];
  installSignalHandlers?: boolean;
};

export type RovaServerHandle = {
  url: URL;
  port: number;
  stop: () => Promise<void>;
};

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function resolveLogger(logger: RovaLogger | undefined): RovaLogger {
  return logger ?? (getAppLogger("server") as unknown as RovaLogger);
}

function registerRuntimeExtensions(options: RovaServerStartOptions): void {
  for (const trigger of options.triggers ?? []) {
    registerWorkflowTrigger(trigger);
  }

  for (const action of options.actions ?? []) {
    registerRuntimeAction(action);
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

export async function startRovaServer(
  options: RovaServerStartOptions
): Promise<RovaServerHandle> {
  assertRequiredConfig(options);

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
  const port = options.port ?? Number(Bun.env.PORT ?? 4017);
  const bunServer = serve({
    port,
    development: Bun.env.NODE_ENV !== "production",
    routes: {
      "/": appHtml,
      "/workflows": appHtml,
      "/workflows/:workflowId": appHtml,
    },
    fetch(req) {
      const url = new URL(req.url);
      const pathname = normalizePath(url.pathname);

      if (pathname.startsWith("/api/")) {
        return apiApp.fetch(req);
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });

  const defaultInngestSdkUrl = new URL(
    "/api/inngest",
    bunServer.url
  ).toString();
  startInngestDevServer({
    enabled: options.inngest.devServer?.enabled ?? false,
    ...options.inngest.devServer,
    sdkUrl:
      options.inngest.devServer?.sdkUrl &&
      options.inngest.devServer.sdkUrl.length > 0
        ? options.inngest.devServer.sdkUrl
        : [defaultInngestSdkUrl],
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }

    stopping = true;

    try {
      bunServer.stop(true);
    } catch (error) {
      logger.error("Failed to stop Bun server", { error });
    }

    await stopInngestDevServer();
  };

  const signalHandlers = new Map<string, () => void>();
  if (options.installSignalHandlers !== false) {
    const signals = ["SIGINT", "SIGTERM"] as const;
    for (const signal of signals) {
      const handler = () => {
        logger.warn("Received shutdown signal", { signal });
        stop().catch((error) => {
          logger.error("Failed to stop server after signal", { error, signal });
        });
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  logger.info("Server listening", { url: bunServer.url, port });

  return {
    url: bunServer.url,
    port,
    stop: async () => {
      for (const [signal, handler] of signalHandlers.entries()) {
        process.off(signal, handler);
      }
      signalHandlers.clear();
      await stop();
    },
  };
}

export const server = {
  start: startRovaServer,
};
