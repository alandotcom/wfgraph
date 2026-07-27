import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { createApiApp } from "@/backend/api-app";
import {
  configureDatabaseRuntime,
  type DatabaseRuntimeConfig,
} from "@/backend/lib/db";
import {
  configureEncryptionKey,
  type EncryptionRuntimeConfig,
  assertValidEncryptionKey,
} from "@/backend/lib/db/integrations";
import {
  type MigrationsRuntimeOptions,
  runMigrations,
} from "@/backend/lib/db/migrations";
import {
  type Authorize,
  resolveAuthorize,
  type RovaAuth,
  UNAUTHORIZED_BODY,
} from "@/backend/lib/http/authorize";
import { serveClientAsset } from "@/backend/lib/http/client-assets";
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

export type { DatabaseRuntimeConfig } from "@/backend/lib/db";
export type { EncryptionRuntimeConfig } from "@/backend/lib/db/integrations";
export type {
  InngestClientRuntimeConfig,
  InngestServeRuntimeConfig,
} from "@/backend/lib/inngest/client";
export type { RovaAuth } from "@/backend/lib/http/authorize";
export type { IntegrationType } from "@rova/shared/types/integration";
export type { RovaLogger } from "@rova/shared/types/logger";
export type { RuntimeExtensionActionDefinition } from "@rova/shared/workflow/action-registry";
export type { RuntimeExtensionTriggerDefinition } from "@rova/shared/workflow/trigger-registry";

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

/**
 * One Rova per process.
 *
 * The database handle, the Inngest client, the encryption key, and both
 * registries are process-global, so a second app with a different database URL
 * silently aliases the first connection and the damage shows up later as data in
 * the wrong database. Threading an instance handle through all of them buys
 * nothing yet: two instances means two tenants, and no table carries a tenant
 * column. Relaxing this later is invisible to every existing caller.
 */
const IDENTITY_FIELDS = [
  "databaseUrl",
  "encryptionKey",
  "inngestClientId",
] as const;

type RovaInstanceIdentity = Record<(typeof IDENTITY_FIELDS)[number], string>;

declare global {
  var __rovaActiveInstance:
    | { identity: RovaInstanceIdentity; holders: number }
    | undefined;
}

/**
 * Take the process, and hand back the release.
 *
 * Counted rather than a flag, because two apps of the same identity are allowed
 * and a single boolean would let the first one's dispose hand the process to a
 * third app with a different database while the second is still serving.
 */
function claimProcess(identity: RovaInstanceIdentity): () => void {
  const active = globalThis.__rovaActiveInstance;

  if (active) {
    const differing = IDENTITY_FIELDS.filter(
      (field) => active.identity[field] !== identity[field]
    );

    if (differing.length > 0) {
      throw new Error(
        `A Rova app is already running in this process with a different ${differing.join(", ")}. Rova holds its database, Inngest client, and registries as process globals, so one process runs one app. Call dispose() on the first before creating another.`
      );
    }
  }

  globalThis.__rovaActiveInstance = {
    identity,
    holders: (active?.holders ?? 0) + 1,
  };

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;

    const current = globalThis.__rovaActiveInstance;
    if (!current) {
      return;
    }

    globalThis.__rovaActiveInstance =
      current.holders <= 1
        ? undefined
        : { ...current, holders: current.holders - 1 };
  };
}

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

  assertValidEncryptionKey(options.encryption.key);

  // Before any configure* call, so a conflict is reported from here rather than
  // by whichever global happens to notice first.
  const releaseProcess = claimProcess({
    databaseUrl: options.database.url.trim(),
    encryptionKey: options.encryption.key.trim(),
    inngestClientId: options.inngest.client.id.trim(),
  });

  try {
    return await buildRovaApp(options, { basePath, authorize, releaseProcess });
  } catch (error) {
    // A claim left behind by a failed startup would answer the retry with "an
    // app is already running" and bury the real error.
    releaseProcess();
    throw error;
  }
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
  runtime: {
    basePath: "" | `/${string}`;
    authorize: Authorize;
    releaseProcess: () => void;
  }
): Promise<RovaApp> {
  const { basePath, authorize, releaseProcess } = runtime;

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

  const dispose = (): void => {
    releaseProcess();

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
