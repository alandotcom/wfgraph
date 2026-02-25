import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { computeMountPrefix, createApiApp } from "@/backend/app";
import {
  configureDatabaseRuntime,
  type DatabaseRuntimeConfig,
} from "@/backend/lib/db";
import {
  configureEncryptionKey,
  type EncryptionRuntimeConfig,
} from "@/backend/lib/db/integrations";
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
  configureAppLogging,
  configureAppLoggingWithBridge,
} from "@/backend/lib/logger";
import { initializeWorkflowTriggers } from "@/backend/lib/workflow-trigger-bootstrap";
// Built-in integration plugins — auto-register on import
import "@/plugins/acuity";
import "@/plugins/clerk";
import "@/plugins/linear";
import "@/plugins/resend";
import "@/plugins/slack";
import "@/plugins/twilio";

import { unregisterIntegration } from "@/shared/plugins/registry";
import {
  type IntegrationType,
  isIntegrationType,
} from "@/shared/types/integration";
import type { RovaLogger } from "@/shared/types/logger";
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

export type { DatabaseRuntimeConfig } from "@/backend/lib/db";
export type { EncryptionRuntimeConfig } from "@/backend/lib/db/integrations";
export type {
  InngestClientRuntimeConfig,
  InngestServeRuntimeConfig,
} from "@/backend/lib/inngest/client";
export type { IntegrationType } from "@/shared/types/integration";
export type { RovaLogger } from "@/shared/types/logger";
export type { RuntimeExtensionActionDefinition } from "@/shared/workflow/action-registry";
export type { RuntimeExtensionTriggerDefinition } from "@/shared/workflow/trigger-registry";

export type PluginConfig = {
  /** Whether this plugin is enabled (default: true) */
  enabled?: boolean;
};

export type RovaAppOptions = {
  logger?: RovaLogger;
  configureLogging?: boolean;
  database: DatabaseRuntimeConfig;
  migrations?: Omit<MigrationsRuntimeOptions, "runOnStartup"> & {
    runOnStartup?: boolean;
  };
  encryption: EncryptionRuntimeConfig;
  inngest: {
    client: InngestClientRuntimeConfig;
    serve?: InngestServeRuntimeConfig;
  };
  triggers?: RuntimeExtensionTriggerDefinition[];
  actions?: RuntimeExtensionActionDefinition[];
  /** Per-plugin configuration (all enabled by default) */
  plugins?: Partial<Record<IntegrationType, PluginConfig>>;
  serveClient?: boolean;
};

export type RovaApp = {
  app: Hono;
  dispose: () => void;
};

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const SAFE_PATH_RE = /^[a-zA-Z0-9/_.-]*$/;

function getContentType(filePath: string): string {
  return (
    CONTENT_TYPE_MAP[extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

async function resolveClientDir(): Promise<string> {
  const currentDir = dirname(fileURLToPath(import.meta.url));

  // Built dist layout: dist/hono.mjs → dist/client/
  const distClient = join(currentDir, "client");
  if (await fileExists(join(distClient, "index.html"))) {
    return distClient;
  }

  // Source dev layout: src/hono.ts → ../dist/client/ (after build:client)
  const devClient = join(currentDir, "../dist/client");
  if (await fileExists(join(devClient, "index.html"))) {
    return devClient;
  }

  return distClient;
}

function resolveClientAssetPath(
  clientDir: string,
  pathname: string
): string | null {
  if (pathname === "/") {
    return null;
  }

  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  if (!relativePath) {
    return null;
  }

  const normalized = posix.normalize(relativePath);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }

  const resolved = join(clientDir, normalized);
  const resolvedNormalized = normalize(resolved);
  const clientDirNormalized = normalize(clientDir);
  if (!resolvedNormalized.startsWith(clientDirNormalized)) {
    return null;
  }

  return resolved;
}

function sanitizeMountPrefix(prefix: string): string {
  if (!(prefix && SAFE_PATH_RE.test(prefix))) {
    return "";
  }
  return prefix;
}

const SPA_PATHS = new Set(["/", "/workflows"]);

function isSpaPath(pathname: string): boolean {
  return SPA_PATHS.has(pathname) || pathname.startsWith("/workflows/");
}

export async function createRovaApp(options: RovaAppOptions): Promise<RovaApp> {
  if (!options.database.url?.trim()) {
    throw new Error("createRovaApp requires database.url");
  }

  if (!options.inngest.client.id?.trim()) {
    throw new Error("createRovaApp requires inngest.client.id");
  }

  if (options.plugins) {
    for (const [type, config] of Object.entries(options.plugins)) {
      if (config?.enabled === false && isIntegrationType(type)) {
        unregisterIntegration(type);
      }
    }
  }

  if (options.logger) {
    configureAppLoggingWithBridge(options.logger);
  } else if (options.configureLogging !== false) {
    configureAppLogging();
  }

  configureEncryptionKey(options.encryption);

  configureDatabaseRuntime(options.database);
  configureInngestClient(options.inngest.client);
  configureInngestServe(options.inngest.serve);

  const registeredTriggerTypes = new Set<string>();
  const registeredActionIds = new Set<string>();

  for (const trigger of options.triggers ?? []) {
    registerWorkflowTrigger(trigger);
    registeredTriggerTypes.add(trigger.runtime.type.trim());
  }

  for (const action of options.actions ?? []) {
    registerRuntimeAction(action);
    registeredActionIds.add(action.id.trim());
  }

  initializeWorkflowTriggers();

  await runMigrations({
    runOnStartup: options.migrations?.runOnStartup === true,
    migrationsDir: options.migrations?.migrationsDir,
  });

  const apiApp = createApiApp({ basePath: "/api" });
  const fullApp = new Hono();

  fullApp.route("/", apiApp);

  if (options.serveClient !== false) {
    const clientDir = await resolveClientDir();

    fullApp.get("/*", async (c) => {
      const pathname = c.req.path;

      // Try to serve a static asset (non-SPA paths only)
      if (!isSpaPath(pathname)) {
        const assetPath = resolveClientAssetPath(clientDir, pathname);
        if (assetPath && (await fileExists(assetPath))) {
          const content = await readFile(assetPath);
          return new Response(content, {
            headers: { "content-type": getContentType(assetPath) },
          });
        }

        // Non-SPA path with no matching asset -> 404
        return c.json({ error: "Not found" }, 404);
      }

      // SPA fallback — serve index.html with injected base path
      const indexPath = join(clientDir, "index.html");
      if (!(await fileExists(indexPath))) {
        return c.json(
          { error: "Client bundle not found. Build the library first." },
          503
        );
      }

      const html = await readFile(indexPath, "utf-8");
      const basePath = sanitizeMountPrefix(computeMountPrefix(c));
      const rewritten = html.replace(
        '<base href="/">',
        `<base href="${basePath}/">`
      );
      return c.html(rewritten);
    });
  }

  const dispose = (): void => {
    for (const triggerType of registeredTriggerTypes) {
      unregisterWorkflowTrigger(triggerType);
    }
    registeredTriggerTypes.clear();

    for (const actionId of registeredActionIds) {
      unregisterRuntimeAction(actionId);
    }
    registeredActionIds.clear();
  };

  return { app: fullApp, dispose };
}
