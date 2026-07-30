import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { createApiApp } from "#src/backend/api-app";
import {
  assertDatabaseConfig,
  configureDatabaseRuntime,
  type DatabaseRuntimeConfig,
  describeConnection,
  getQueryClient,
} from "#src/backend/lib/db/index";
import {
  configureEncryptionKey,
  type EncryptionRuntimeConfig,
  assertValidEncryptionKey,
} from "#src/backend/lib/db/integrations";
import {
  type MigrationsOptions,
  runMigrations,
} from "#src/backend/lib/db/migrations";
import {
  type Authorize,
  resolveAuthorize,
  type RovaAuth,
  UNAUTHORIZED_BODY,
} from "#src/backend/lib/http/authorize";
import { serveClientAsset } from "#src/backend/lib/http/client-assets";
import {
  normalizeBasePath,
  toMountRelativePath,
} from "#src/backend/lib/http/mount-path";
import {
  clearExtensions,
  configureExtensions,
} from "#src/backend/lib/extensions/current";
import type { AnyEventDefinition } from "#src/backend/lib/extensions/define-event";
import type { IntegrationDefinition } from "#src/backend/lib/extensions/define-integration";
import { assembleExtensions } from "#src/backend/lib/extensions/extension-set";
import {
  catalogActionsFromRegistries,
  catalogIntegrationsFromRegistries,
} from "#src/backend/lib/extensions/from-registries";
import {
  configureInngest,
  type RovaInngestConfig,
  reportInngestCallbackExposure,
} from "#src/backend/lib/inngest/client";
import { invalidateInngestFunctionsCache } from "#src/backend/lib/inngest/functions";
import {
  configureAppLogging,
  configureAppLoggingWithBridge,
  getAppLogger,
} from "#src/backend/lib/logger";
import { initializeWorkflowTriggers } from "#src/backend/lib/workflow-trigger-bootstrap";
import { createRovaRuntime, type RovaRuntime } from "#src/backend/runtime";
import { unregisterIntegration } from "@rova/shared/plugins/registry";
import {
  type IntegrationType,
  isIntegrationType,
} from "@rova/shared/types/integration";
import type { RovaLogger } from "@rova/shared/types/logger";
import {
  type RuntimeExtensionActionDefinition,
  registerRuntimeAction,
  unregisterRuntimeAction,
} from "@rova/shared/workflow/action-registry";
import {
  type RuntimeExtensionTriggerDefinition,
  registerWorkflowTrigger,
  unregisterWorkflowTrigger,
} from "@rova/shared/workflow/trigger-registry";

export type { DatabaseRuntimeConfig } from "#src/backend/lib/db/index";
export type { MigrationsOptions } from "#src/backend/lib/db/migrations";
export type { EncryptionRuntimeConfig } from "#src/backend/lib/db/integrations";
export type { RovaInngestConfig } from "#src/backend/lib/inngest/client";
export type { RovaAuth } from "#src/backend/lib/http/authorize";
export type { IntegrationType } from "@rova/shared/types/integration";
export type { RovaLogger } from "@rova/shared/types/logger";
export type { RuntimeExtensionActionDefinition } from "@rova/shared/workflow/action-registry";
export type { RuntimeExtensionTriggerDefinition } from "@rova/shared/workflow/trigger-registry";

export type PluginConfig = {
  /** Whether this plugin is enabled (default: true) */
  enabled?: boolean;
};

/**
 * The extension surface, assembled in one place.
 *
 * An integration listed here brings its actions, its steps and its connection
 * test with it, so this line is what turns it on and dropping it is what turns it
 * off. A host action still arrives through `actions` below and the plugins B4 has
 * not ported still turn themselves on by being imported, so those two halves are
 * read out of the registries at startup and join this option in the catalog.
 */
export type RovaExtensionOptions = {
  readonly events?: readonly AnyEventDefinition[];
  readonly integrations?: readonly IntegrationDefinition[];
};

/**
 * Where the database is, which schema Rova lives in, and whether it migrates on
 * the way up. Migrations sit here rather than beside `database` because they are
 * a statement about the same database, and a host reading the options should not
 * have to notice that two top-level keys describe one thing.
 */
export type RovaDatabaseOptions = DatabaseRuntimeConfig & {
  migrations?: MigrationsOptions;
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
  database: RovaDatabaseOptions;
  encryption: EncryptionRuntimeConfig;
  inngest: RovaInngestConfig;
  triggers?: RuntimeExtensionTriggerDefinition[];
  actions?: RuntimeExtensionActionDefinition[];
  extensions?: RovaExtensionOptions;
  /** Per-plugin configuration (all enabled by default) */
  plugins?: Partial<Record<IntegrationType, PluginConfig>>;
  /**
   * The workflow editor, from `import { clientBundle } from "@rova/client"`.
   *
   * Rova serves the editor when a host hands it one and serves nothing when they
   * do not, so turning the UI on is a line in the host's code rather than a
   * consequence of what happens to be installed. `@rova/core` does not depend on
   * `@rova/client` in either direction.
   */
  client?: RovaClientBundle;
};

/** Structural, so `@rova/core` and `@rova/client` need no dependency between them. */
export type RovaClientBundle = {
  /** Directory holding index.html and the hashed asset chunks beside it. */
  dir: string;
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
  /**
   * Give back everything this app holds. Awaiting it waits for the Effect
   * runtime's Layers to finalize; a host that fires and forgets still releases
   * the registrations synchronously.
   */
  dispose: () => Promise<void>;
};

/**
 * One Rova per process.
 *
 * The database handle, the Inngest client, the encryption key, and both
 * registries are process-global, so a second app with a different database URL
 * silently aliases the first connection. ADR-0002 makes a second app per
 * process undefined behavior rather than a supported arrangement that fails
 * loudly.
 */
export async function createRovaApp(options: RovaAppOptions): Promise<RovaApp> {
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const authorize = resolveAuthorize(options.auth);

  assertDatabaseConfig(options.database);

  if (!options.inngest.id?.trim()) {
    throw new Error("createRovaApp requires inngest.id");
  }

  assertValidEncryptionKey(options.encryption.key);

  return await buildRovaApp(options, { basePath, authorize });
}

/**
 * A bad `client.dir` is a startup mistake, so it fails at startup. Left to the
 * request path it becomes a 503 on every page load, and the message there cannot
 * name what went wrong: a host bundling their server with a tool that rewrites
 * `import.meta.url` gets a directory that points nowhere, which is not something
 * a per-request handler can explain.
 */
async function assertClientBundle(clientDir: string): Promise<void> {
  const entry = join(clientDir, "index.html");
  try {
    await stat(entry);
  } catch {
    throw new Error(
      `createRovaApp's client.dir does not hold an index.html: looked for ${entry}. Pass clientBundle from @rova/client, or the directory of your own build of the editor.`
    );
  }
}

async function buildRovaApp(
  options: RovaAppOptions,
  startup: {
    basePath: "" | `/${string}`;
    authorize: Authorize;
  }
): Promise<RovaApp> {
  const { basePath, authorize } = startup;

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
  configureInngest(options.inngest);
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

  // The registries have to be full before they are read: a plugin fills its own
  // as the host's module graph loads, and a host action fills the other in the
  // loop above.
  const extensions = assembleExtensions({
    events: options.extensions?.events,
    integrations: options.extensions?.integrations,
    registries: {
      actions: catalogActionsFromRegistries(),
      integrations: catalogIntegrationsFromRegistries(),
    },
  });
  configureExtensions(extensions);

  // A host who forgets to import the integrations gets an empty editor and no
  // error, so the counts go where a startup log is read.
  const { events, actions, integrations } = extensions.catalog;
  getAppLogger("extensions").info(
    `Extension surface assembled: ${events.length} events, ${actions.length} actions, ${integrations.length} integrations`
  );

  // Where the tables are is a startup fact worth one line: Rova lives in a schema
  // of a database the host chose, and "it is reading the wrong schema" is
  // otherwise a guess made from an empty editor.
  getAppLogger("database").info(
    "Database configured",
    describeConnection(getQueryClient())
  );

  if (options.database.migrations?.runOnStartup === true) {
    await runMigrations({
      migrationsDir: options.database.migrations.migrationsDir,
    });
  }

  // The Layer graph this instance owns. Building it is lazy, so an app that
  // never serves a migrated procedure never constructs a service.
  const runtime = createRovaRuntime();

  try {
    return await assembleRovaApp(options, {
      basePath,
      authorize,
      runtime,
      registeredTriggerTypes,
      registeredActionIds,
    });
  } catch (error) {
    // Nothing else holds this runtime yet, so a failure from here on leaves it
    // to be finalized by whoever created it, which is this function.
    await runtime.dispose();
    throw error;
  }
}

/**
 * Everything after the runtime exists, split out so the `catch` above has a
 * whole function to guard: a bad `client.dir` throws from in here, and the
 * runtime built a few lines earlier has to be finalized rather than left holding
 * whatever its Layers acquired.
 */
async function assembleRovaApp(
  options: RovaAppOptions,
  startup: {
    basePath: "" | `/${string}`;
    authorize: Authorize;
    runtime: RovaRuntime;
    registeredTriggerTypes: Set<string>;
    registeredActionIds: Set<string>;
  }
): Promise<RovaApp> {
  const {
    basePath,
    authorize,
    runtime,
    registeredTriggerTypes,
    registeredActionIds,
  } = startup;

  const apiApp = createApiApp({
    basePath: `${basePath}/api`,
    authorize,
    runtime,
  });
  const fullApp = new Hono();

  fullApp.route("/", apiApp);

  const clientDir = options.client?.dir;
  if (clientDir) {
    await assertClientBundle(clientDir);

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

  const dispose = async (): Promise<void> => {
    for (const triggerType of registeredTriggerTypes) {
      unregisterWorkflowTrigger(triggerType);
    }
    registeredTriggerTypes.clear();

    for (const actionId of registeredActionIds) {
      unregisterRuntimeAction(actionId);
    }
    registeredActionIds.clear();

    clearExtensions();

    // The cached Inngest functions close over this runtime, so they go before
    // it does. Otherwise a `/inngest` request arriving during teardown is
    // served event listeners that run services on a finalized runtime.
    invalidateInngestFunctionsCache();

    await runtime.dispose();
  };

  return {
    fetch: async (request) => await fullApp.fetch(request),
    basePath,
    dispose,
  };
}
