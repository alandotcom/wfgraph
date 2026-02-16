import { startRovaServer } from "@/rova/server";

const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";

function toOptionalUrl(value: string | undefined): string | undefined {
  if (!value) {
    return;
  }

  try {
    return new URL(value).toString();
  } catch {
    return;
  }
}

const inngestBaseUrl =
  toOptionalUrl(Bun.env.INNGEST_BASE_URL) ?? toOptionalUrl(Bun.env.INNGEST_DEV);
const appPort = Number(Bun.env.PORT ?? 4017);
const runInngestDevServer = Bun.env.ROVA_INNGEST_DEV_SERVER === "true";
const inngestDevServerPort = Number(
  Bun.env.ROVA_INNGEST_DEV_SERVER_PORT ?? 8388
);
const inngestConnectGatewayPort = Number(
  Bun.env.ROVA_INNGEST_CONNECT_GATEWAY_PORT ?? 8390
);
const inngestConnectGatewayGrpcPort = Number(
  Bun.env.ROVA_INNGEST_CONNECT_GATEWAY_GRPC_PORT ?? 50_062
);
const inngestConnectExecutorGrpcPort = Number(
  Bun.env.ROVA_INNGEST_CONNECT_EXECUTOR_GRPC_PORT ?? 50_063
);
const inngestDevServerMode =
  Bun.env.ROVA_INNGEST_DEV_SERVER_MODE === "start" ? "start" : "dev";

const devServerExtraArgs = [
  "--connect-gateway-port",
  String(
    Number.isFinite(inngestConnectGatewayPort)
      ? inngestConnectGatewayPort
      : 8390
  ),
  "--connect-gateway-grpc-port",
  String(
    Number.isFinite(inngestConnectGatewayGrpcPort)
      ? inngestConnectGatewayGrpcPort
      : 50_062
  ),
  "--connect-executor-grpc-port",
  String(
    Number.isFinite(inngestConnectExecutorGrpcPort)
      ? inngestConnectExecutorGrpcPort
      : 50_063
  ),
];

await startRovaServer({
  port: appPort,
  database: {
    url: Bun.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
  migrations: {
    runOnStartup: Bun.env.RUN_DB_MIGRATIONS === "true",
    migrationsDir: Bun.env.MIGRATIONS_DIR,
  },
  inngest: {
    client: {
      id: Bun.env.INNGEST_APP_ID ?? "notifications-workflow",
      isDev: Bun.env.NODE_ENV !== "production",
      baseUrl: inngestBaseUrl,
      eventKey: Bun.env.INNGEST_EVENT_KEY,
      env: Bun.env.INNGEST_ENV,
    },
    serve: {
      signingKey: Bun.env.INNGEST_SIGNING_KEY,
      signingKeyFallback: Bun.env.INNGEST_SIGNING_KEY_FALLBACK,
      serveHost: Bun.env.INNGEST_SERVE_HOST,
      servePath: Bun.env.INNGEST_SERVE_PATH,
    },
    devServer: {
      enabled: runInngestDevServer,
      mode: inngestDevServerMode,
      port: Number.isFinite(inngestDevServerPort) ? inngestDevServerPort : 8388,
      noDiscovery: true,
      persist: true,
      env: {
        DO_NOT_TRACK: "1",
      },
      extraArgs: devServerExtraArgs,
    },
  },
});
