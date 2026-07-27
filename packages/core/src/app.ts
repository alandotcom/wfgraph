import { Hono } from "hono";
import { createApiApp } from "@/backend/api-app";
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
  resolveAuthorize,
  type RovaAuth,
  UNAUTHORIZED_BODY,
} from "@/backend/lib/http/authorize";
import {
  resolveClientDir,
  serveClientAsset,
} from "@/backend/lib/http/client-assets";
import {
  normalizeBasePath,
  toMountRelativePath,
} from "@/backend/lib/http/mount-path";
import {
  configureInngestClient,
  configureInngestServe,
  type InngestClientRuntimeConfig,
  type InngestServeRuntimeConfig,
  reportInngestCallbackExposure,
} from "@/backend/lib/inngest/client";
import {
  configureAppLogging,
  configureAppLoggingWithBridge,
} from "@/backend/lib/logger";
import { initializeWorkflowTriggers } from "@/backend/lib/workflow-trigger-bootstrap";
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
export type { RovaAuth } from "@/backend/lib/http/authorize";
export type { IntegrationType } from "@/shared/types/integration";
export type { RovaLogger } from "@/shared/types/logger";
export type { RuntimeExtensionActionDefinition } from "@/shared/workflow/action-registry";
export type { RuntimeExtensionTriggerDefinition } from "@/shared/workflow/trigger-registry";

export type PluginConfig = {
  /** Whether this plugin is enabled (default: true) */
  enabled?: boolean;
};

export type RovaAppOptions = {
  /**
   * Absolute path the host mounted Rova at, for example "/workflows". Defaults
   * to "/". Rova builds its API prefix, its asset URLs, and the SPA's
   * `<base href>` from this, so a host that mounts under a sub-path says so
   * once here instead of Rova guessing per request.
   */
  basePath?: string;
  /**
   * Who may reach the editor: a predicate over the request, or "external" when
   * something in front of Rova already gates it.
   *
   * Required everywhere rather than only in production, since the check that
   * would tell the two apart reads an environment variable that says
   * "production" and misses "prod" and an unset one. Covers everything Rova
   * serves except `MACHINE_ROUTES`.
   */
  auth: RovaAuth;
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
  /**
   * The whole mounted app as one fetch handler. Bun, Deno, Cloudflare Workers,
   * and Node 18+ all consume this directly; `@rova/core/node` translates it for
   * hosts that speak Node's `IncomingMessage`/`ServerResponse` instead.
   */
  fetch: (request: Request) => Promise<Response>;
  /**
   * The normalized `basePath`: "" for a root mount, otherwise a leading slash
   * with no trailing one. Every route this app answers sits under it, which is
   * what lets an adapter tell a mount-point mismatch from an ordinary 404.
   */
  basePath: "" | `/${string}`;
  dispose: () => void;
};

export async function createRovaApp(options: RovaAppOptions): Promise<RovaApp> {
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const authorize = resolveAuthorize(options.auth);

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
  reportInngestCallbackExposure();

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

  const apiApp = createApiApp({ basePath: `${basePath}/api`, authorize });
  const fullApp = new Hono();

  fullApp.route("/", apiApp);

  if (options.serveClient !== false) {
    const clientDir = await resolveClientDir();

    fullApp.get("/*", async (c) => {
      const pathname = toMountRelativePath(c.req.path, basePath);
      if (pathname === null) {
        return c.json({ error: "Not found" }, 404);
      }

      // A host wanting a login redirect instead of a 401 puts it in front of
      // the mount.
      if (!(await authorize(c.req.raw))) {
        return c.json(UNAUTHORIZED_BODY, 401);
      }

      return await serveClientAsset({ clientDir, basePath, pathname });
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

  return {
    fetch: async (request) => await fullApp.fetch(request),
    basePath,
    dispose,
  };
}
