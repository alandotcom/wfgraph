import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { createApiApp } from "#src/backend/api-app";
import {
  type DatabaseRuntimeConfig,
  normalizeDatabaseConfig,
  type NormalizedDatabaseConfig,
} from "#src/backend/lib/db/config";
import {
  createDatabaseSurface,
  type DatabaseSurface,
  describeConnection,
} from "#src/backend/lib/db/index";
import {
  assertValidEncryptionKey,
  createIntegrationCipher,
  type EncryptionRuntimeConfig,
} from "#src/backend/services/integrations/cipher";
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
  assembleExtensions,
  type RovaExtensions,
} from "#src/backend/extensions/extension-set";
import {
  createInngestSurface,
  type InngestSurface,
  type RovaInngestConfig,
  type WorkerConnection,
} from "#src/backend/lib/inngest/client";
import { buildInngestFunctions } from "#src/backend/lib/inngest/functions";
import {
  configureAppLogging,
  configureAppLoggingWithBridge,
  getAppLogger,
} from "#src/backend/lib/logger";
import { createRovaRuntime, type RovaRuntime } from "#src/backend/runtime";
import type { RovaLogger } from "@rova/shared/types/logger";

export type { DatabaseRuntimeConfig } from "#src/backend/lib/db/config";
export type { MigrationsOptions } from "#src/backend/lib/db/migrations";
export type { EncryptionRuntimeConfig } from "#src/backend/services/integrations/cipher";
export type { RovaInngestConfig } from "#src/backend/lib/inngest/client";
export type { RovaAuth } from "#src/backend/lib/http/authorize";
export type { RovaLogger } from "@rova/shared/types/logger";
export type { RovaExtensions } from "#src/backend/extensions/extension-set";

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
   * serves except machine routes (the wait resume path, and `/inngest` when
   * HTTP serve is mounted).
   */
  auth: RovaAuth;
  /**
   * Where Rova's own log lines go. Absent, Rova configures a console sink of
   * its own; present, every line is handed to this instead.
   */
  logger?: RovaLogger;
  database: RovaDatabaseOptions;
  encryption: EncryptionRuntimeConfig;
  inngest: RovaInngestConfig;
  /**
   * The whole extension surface, in one place.
   *
   * Nothing registers itself, so what is listed here is what this app has: an
   * integration brings its actions, its steps and its connection test with it, an
   * Event brings its listener, and a `defineAction` brings its handler. Dropping
   * a line is what turns something off.
   */
  extensions?: RovaExtensions;
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
   * and Node 18+ all consume this directly; `createRequestListener` translates
   * it for hosts that speak Node's `IncomingMessage`/`ServerResponse` instead.
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
   * the registrations synchronously. When `inngest.connect` was set, the
   * Connect worker is drained first.
   */
  dispose: () => Promise<void>;
};

/**
 * One Rova per process.
 *
 * Everything an app holds is its own, but the arrangement is still the only
 * supported one (ADR-0002): a second app naming a different database is refused
 * where the pool is claimed, and the parts of Rova that a host reaches through
 * the module graph have never been written for two.
 */
export async function createRovaApp(options: RovaAppOptions): Promise<RovaApp> {
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const authorize = resolveAuthorize(options.auth);

  // Normalized here rather than inside `createDatabaseSurface` a few steps
  // later, so a config naming no database is refused before this call has
  // changed anything about the process.
  const databaseConfig = normalizeDatabaseConfig(options.database);

  if (!options.inngest.id?.trim()) {
    throw new Error("createRovaApp requires inngest.id");
  }

  assertValidEncryptionKey(options.encryption.key);

  return await buildRovaApp(options, { basePath, authorize, databaseConfig });
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
    databaseConfig: NormalizedDatabaseConfig;
  }
): Promise<RovaApp> {
  const { basePath, authorize, databaseConfig } = startup;

  if (options.logger) {
    configureAppLoggingWithBridge(options.logger);
  } else {
    configureAppLogging();
  }

  const cipher = createIntegrationCipher(options.encryption);

  // The pool, and this process's claim on the database it points at.
  const database = createDatabaseSurface(databaseConfig);

  // Everything past this point can fail with the pool already open, and past
  // `createRovaRuntime` with whatever the Layers acquired. A failure gives both
  // back, the same as dispose does, so a host that catches a startup failure,
  // corrects an option and calls again is not refused as a rebind.
  let runtime: RovaRuntime | undefined;
  try {
    // One value for the Inngest client this app sends on, built before the
    // runtime because the Layer graph takes it. Functions are registered later,
    // once the runtime exists, on either Connect or HTTP serve.
    const inngest = createInngestSurface(options.inngest);

    const extensions = assembleExtensions(options.extensions ?? {});

    // A host who forgets to pass its integrations gets an empty editor and no
    // error, so the counts go where a startup log is read.
    const { events, actions, integrations } = extensions.catalog;
    getAppLogger("extensions").info(
      `Extension surface assembled: ${events.length} events, ${actions.length} actions, ${integrations.length} integrations`
    );

    // Where the tables are is a startup fact worth one line: Rova lives in a
    // schema of a database the host chose, and "it is reading the wrong schema"
    // is otherwise a guess made from an empty editor.
    getAppLogger("database").info(
      "Database configured",
      describeConnection(database.client, database.schema)
    );

    if (options.database.migrations?.runOnStartup === true) {
      await runMigrations(databaseConfig, {
        migrationsDir: options.database.migrations.migrationsDir,
      });
    }

    // The Layer graph this instance owns. Building it is lazy, so an app that
    // never serves a migrated procedure never constructs a service.
    runtime = createRovaRuntime({ inngest, extensions, database, cipher });

    return await assembleRovaApp(options, {
      basePath,
      authorize,
      runtime,
      inngest,
      database,
    });
  } catch (error) {
    await runtime?.dispose();
    await database.close();
    throw error;
  }
}

/** Everything after the runtime exists: the routes, the editor, and dispose. */
async function assembleRovaApp(
  options: RovaAppOptions,
  startup: {
    basePath: "" | `/${string}`;
    authorize: Authorize;
    runtime: RovaRuntime;
    inngest: InngestSurface;
    database: DatabaseSurface;
  }
): Promise<RovaApp> {
  const { basePath, authorize, runtime, inngest, database } = startup;

  // Built once: Connect and HTTP serve are alternatives, and whichever path
  // this app takes registers that same list. A broken extension surface fails
  // at boot instead of on the first request or Connect handshake.
  const functions = await buildInngestFunctions(inngest.client, runtime);
  const useConnect = options.inngest.connect === true;
  const apiApp = createApiApp({
    basePath: `${basePath}/api`,
    authorize,
    runtime,
    // Connect dials out; mounting `/inngest` would advertise a callback Inngest
    // cannot reach on a private network and is not how Connect syncs.
    inngestHandler: useConnect ? undefined : inngest.serve(functions),
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

  // Connect last so a failed client-bundle check never leaves a live WebSocket.
  let workerConnection: WorkerConnection | undefined;
  if (useConnect) {
    workerConnection = await inngest.connect(functions);
    getAppLogger("inngest").info(
      `Inngest Connect worker ready: connectionId=${workerConnection.connectionId} state=${workerConnection.state}`
    );
  }

  const dispose = async (): Promise<void> => {
    // Drain Connect before the runtime goes away: in-flight steps still need
    // the Layer graph, and a closed WebSocket is what stops Inngest from
    // dispatching more work to this process.
    if (workerConnection) {
      try {
        await workerConnection.close();
      } catch (error) {
        getAppLogger("inngest").warn(
          `Inngest Connect worker close failed during dispose: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      workerConnection = undefined;
    }

    await runtime.dispose();

    // Last, because a Layer finalizer is free to run a closing query. postgres.js
    // holds an idle socket open per pool, so a host that shuts Rova down gets its
    // process back only once this has run.
    await database.close();
  };

  return {
    fetch: async (request) => await fullApp.fetch(request),
    basePath,
    dispose,
  };
}
