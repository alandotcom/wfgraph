import "@rova/plugins";
import "@rova/plugins/register-steps";
import { startRovaServer } from "@rova/core";
// Bun turns this into a bundle whose script and link tags it transpiles per request, so
// running the dev server needs no client build first. The import lives here, in the
// unpublished dev entrypoint, to keep the client out of @rova/core's own bundle.
import homepage from "./packages/core/client/index.html";

const DEFAULT_DATABASE_URL =
  "postgresql://workflow:workflow@localhost:55437/workflow_builder";

function toOptionalUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}

const inngestBaseUrl =
  toOptionalUrl(Bun.env.INNGEST_BASE_URL) ?? toOptionalUrl(Bun.env.INNGEST_DEV);
const appPort = Number(Bun.env.PORT ?? 4017);

await startRovaServer({
  port: appPort,
  clientHtml: homepage,
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
