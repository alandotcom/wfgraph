import "@rova/plugins";
import "@rova/plugins/register-steps";
import { startRovaServer } from "@rova/core";

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

await startRovaServer({
  port: appPort,
  database: {
    url: Bun.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  },
  encryption: Bun.env.INTEGRATION_ENCRYPTION_KEY
    ? { key: Bun.env.INTEGRATION_ENCRYPTION_KEY }
    : undefined,
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
  },
});
