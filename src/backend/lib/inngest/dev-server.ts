import { getAppLogger } from "@/backend/lib/logger";

export type InngestDevServerMode = "dev" | "start";

export type InngestDevServerConfig = {
  enabled?: boolean;
  mode?: InngestDevServerMode;
  command?: string[];
  extraArgs?: string[];
  env?: Record<string, string>;
  cwd?: string;
  host?: string;
  port?: number;
  sdkUrl?: string[];
  noDiscovery?: boolean;
  noPoll?: boolean;
  persist?: boolean;
  sqliteDir?: string;
};

type InngestDevServerState = {
  process: Bun.Subprocess<"ignore", "inherit", "inherit"> | null;
};

const logger = getAppLogger("inngest", "dev-server");

const globalForInngestDevServer = globalThis as unknown as {
  __rovaInngestDevServerState?: InngestDevServerState;
};

const devServerState: InngestDevServerState =
  globalForInngestDevServer.__rovaInngestDevServerState ?? {
    process: null,
  };

globalForInngestDevServer.__rovaInngestDevServerState = devServerState;

const DEFAULT_DEV_SERVER_COMMAND = ["bun", "run", "inngest-cli"];

function normalizeSdkUrls(config: InngestDevServerConfig): string[] {
  return config.sdkUrl?.map((url) => url.trim()).filter(Boolean) ?? [];
}

function appendCommonArgs(
  args: string[],
  config: InngestDevServerConfig
): void {
  if (typeof config.host === "string" && config.host.trim()) {
    args.push("--host", config.host.trim());
  }

  if (typeof config.port === "number" && Number.isFinite(config.port)) {
    args.push("-p", String(Math.floor(config.port)));
  }
}

function appendSdkUrls(args: string[], sdkUrls: string[]): void {
  for (const url of sdkUrls) {
    args.push("-u", url);
  }
}

function appendDevModeArgs(
  args: string[],
  config: InngestDevServerConfig
): void {
  const sdkUrls = normalizeSdkUrls(config);
  appendSdkUrls(args, sdkUrls);

  if (config.noDiscovery ?? sdkUrls.length > 0) {
    args.push("--no-discovery");
  }

  if (config.noPoll) {
    args.push("--no-poll");
  }

  if (config.persist) {
    args.push("--persist");
  }
}

function appendStartModeArgs(
  args: string[],
  config: InngestDevServerConfig
): void {
  appendSdkUrls(args, normalizeSdkUrls(config));

  if (typeof config.sqliteDir === "string" && config.sqliteDir.trim()) {
    args.push("--sqlite-dir", config.sqliteDir.trim());
  }
}

function buildInngestDevServerCommand(
  config: InngestDevServerConfig
): string[] {
  const mode = config.mode ?? "dev";
  const baseCommand =
    config.command && config.command.length > 0
      ? [...config.command]
      : [...DEFAULT_DEV_SERVER_COMMAND];

  const args: string[] = [mode];
  appendCommonArgs(args, config);

  if (mode === "dev") {
    appendDevModeArgs(args, config);
  }

  if (mode === "start") {
    appendStartModeArgs(args, config);
  }

  if (config.extraArgs?.length) {
    args.push(...config.extraArgs);
  }

  return [...baseCommand, ...args];
}

export function startInngestDevServer(config: InngestDevServerConfig): void {
  if (!config.enabled) {
    return;
  }

  if (devServerState.process) {
    logger.debug("Inngest dev server already running");
    return;
  }

  const command = buildInngestDevServerCommand(config);
  logger.info("Starting Inngest dev server", {
    command,
    cwd: config.cwd ?? process.cwd(),
  });

  const processEnv = {
    ...Bun.env,
    ...(config.env ?? {}),
  };

  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: processEnv,
    cwd: config.cwd ?? process.cwd(),
  });

  devServerState.process = child;

  child.exited
    .then((exitCode) => {
      logger.info("Inngest dev server exited", { exitCode });
      if (devServerState.process === child) {
        devServerState.process = null;
      }
    })
    .catch((error) => {
      logger.warn("Inngest dev server exited with monitoring error", { error });
    });
}

export async function stopInngestDevServer(): Promise<void> {
  const child = devServerState.process;
  if (!child) {
    return;
  }

  devServerState.process = null;

  logger.info("Stopping Inngest dev server");

  try {
    child.kill();
  } catch (error) {
    logger.warn("Failed to signal Inngest dev server", { error });
  }

  try {
    await Promise.race([
      child.exited,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (error) {
    logger.warn("Failed waiting for Inngest dev server shutdown", { error });
  }
}
