import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { createApiApp } from "#src/backend/api-app";
import {
  assertValidEncryptionKey,
  createIntegrationCipher,
  type EncryptionRuntimeConfig,
} from "#src/backend/services/integrations/cipher";
import {
  type Authorize,
  resolveAuthorize,
  type WfGraphAuth,
  UNAUTHORIZED_BODY,
} from "#src/backend/lib/http/authorize";
import { serveClientAsset } from "#src/backend/lib/http/client-assets";
import {
  normalizeBasePath,
  toMountRelativePath,
} from "#src/backend/lib/http/mount-path";
import {
  assembleExtensions,
  type WfGraphExtensions,
} from "#src/backend/extensions/extension-set";
import {
  createInngestSurface,
  type InngestSurface,
  type WfGraphInngestConfig,
  type WorkerConnection,
} from "#src/backend/lib/inngest/client";
import { buildInngestFunctions } from "#src/backend/lib/inngest/functions";
import { connect as connectInngestSdk } from "inngest/connect";
import {
  configureLoggingWithBridge,
  warnWhenLoggingUnconfigured,
} from "#src/backend/lib/log-config";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  readAgentSettings,
  type WfGraphAgentConfig,
} from "#src/backend/agent/config";
import {
  createWfGraphRuntime,
  type WfGraphRuntime,
} from "#src/backend/runtime";
import type {
  WfGraphPersistence,
  WfGraphPersistenceInstance,
} from "#src/backend/persistence/types";
import type { WfGraphLogger } from "@wfgraph/shared/types/logger";
import { closeInOrder, failAfterClose } from "#src/backend/lib/close-in-order";
import { resolvePublicUrl } from "#src/backend/lib/http/public-url";

export type { EncryptionRuntimeConfig } from "#src/backend/services/integrations/cipher";
export type { WfGraphInngestConfig } from "#src/backend/lib/inngest/client";
export type { WfGraphAuth } from "#src/backend/lib/http/authorize";
export type { WfGraphLogger } from "@wfgraph/shared/types/logger";
export type { WfGraphExtensions } from "#src/backend/extensions/extension-set";
export type { WfGraphPersistence } from "#src/backend/persistence/types";

export type WfGraphAppOptions = {
  /**
   * Absolute path the host mounted Workflow Graph at, for example "/workflows". Defaults
   * to "/". Workflow Graph builds its API prefix, its asset URLs, and the SPA's
   * `<base href>` from this, so a host that mounts under a sub-path says so
   * once here instead of Workflow Graph guessing per request.
   */
  basePath?: string;
  /** Public origin used in provider callback URLs and client metadata. */
  publicUrl?: string;
  /**
   * Who may reach the editor: a predicate over the request, or "external" when
   * something in front of Workflow Graph already gates it.
   *
   * Required everywhere rather than only in production, since the check that
   * would tell the two apart reads an environment variable that says
   * "production" and misses "prod" and an unset one. Covers everything Workflow Graph
   * serves except machine routes (the wait resume path, and `/inngest` when
   * HTTP serve is mounted).
   */
  auth: WfGraphAuth;
  /**
   * Where Workflow Graph's own log lines go. Absent, Workflow Graph configures a console sink of
   * its own; present, every line is handed to this instead.
   */
  logger?: WfGraphLogger;
  /** The storage backend Workflow Graph uses for all durable state. */
  persistence: WfGraphPersistence;
  encryption: EncryptionRuntimeConfig;
  inngest: WfGraphInngestConfig;
  /**
   * The whole extension surface, in one place.
   *
   * Nothing registers itself, so what is listed here is what this app has: an
   * integration brings its actions, its steps and its connection test with it, an
   * Event brings its listener, and a `defineAction` brings its handler. Dropping
   * a line is what turns something off.
   */
  extensions?: WfGraphExtensions;
  /**
   * The build agent: the chat panel in the editor that reads the catalog and
   * edits the open workflow.
   *
   * Absent, or with a blank `apiKey`, the agent is off: no model is called, and
   * the editor shows no chat panel. A host passes its own key, conventionally
   * `process.env.OPENAI_API_KEY`.
   */
  agent?: WfGraphAgentConfig;
  /**
   * The workflow editor, from `import { clientBundle } from "@wfgraph/client"`.
   *
   * Workflow Graph serves the editor when a host hands it one and serves nothing when they
   * do not, so turning the UI on is a line in the host's code rather than a
   * consequence of what happens to be installed. `@wfgraph/core` does not depend on
   * `@wfgraph/client` in either direction.
   */
  client?: WfGraphClientBundle;
};

/** Structural, so `@wfgraph/core` and `@wfgraph/client` need no dependency between them. */
export type WfGraphClientBundle = {
  /** Directory holding index.html and the hashed asset chunks beside it. */
  dir: string;
};

export type WfGraphApp = {
  /**
   * The whole mounted Node app as one fetch handler. Fetch-native Node hosts
   * consume it directly; `createRequestListener` translates it for hosts that
   * speak Node's `IncomingMessage`/`ServerResponse` instead. Cloudflare uses
   * the separate `@wfgraph/core/worker` entry.
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
 * One Workflow Graph per process.
 *
 * Everything an app holds is its own, but the arrangement is still the only
 * supported one (ADR-0002): a second app naming a different database is refused
 * where the pool is claimed, and the parts of Workflow Graph that a host reaches through
 * the module graph have never been written for two.
 */
export async function createWfGraphApp(
  options: WfGraphAppOptions
): Promise<WfGraphApp> {
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const publicUrl = resolvePublicUrl(options.publicUrl);
  const authorize = resolveAuthorize(options.auth);

  if (!options.inngest.id?.trim()) {
    throw new Error("createWfGraphApp requires inngest.id");
  }

  assertValidEncryptionKey(options.encryption.key);

  return await buildWfGraphApp(options, {
    basePath,
    publicUrl,
    authorize,
  });
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
      `createWfGraphApp's client.dir does not hold an index.html: looked for ${entry}. Pass clientBundle from @wfgraph/client, or the directory of your own build of the editor.`
    );
  }
}

async function buildWfGraphApp(
  options: WfGraphAppOptions,
  startup: {
    basePath: "" | `/${string}`;
    publicUrl?: string;
    authorize: Authorize;
  }
): Promise<WfGraphApp> {
  const { basePath, publicUrl, authorize } = startup;

  if (options.logger) {
    configureLoggingWithBridge(options.logger);
  } else {
    warnWhenLoggingUnconfigured();
  }

  const cipher = createIntegrationCipher(options.encryption);

  // Everything past this point can fail with persistence already open, and past
  // `createWfGraphRuntime` with whatever the Layers acquired. A failure gives both
  // back, the same as dispose does, so a host that catches a startup failure,
  // corrects an option and calls again is not refused as a rebind.
  let runtime: WfGraphRuntime | undefined;
  let persistence: WfGraphPersistenceInstance | undefined;
  try {
    // One value for the Inngest client this app sends on, built before the
    // runtime because the Layer graph takes it. Functions are registered later,
    // once the runtime exists, on either Connect or HTTP serve.
    const inngest = createInngestSurface(options.inngest, {
      connect: connectInngestSdk,
    });

    const extensions = assembleExtensions(options.extensions ?? {});

    // A host who forgets to pass its integrations gets an empty editor and no
    // error, so the counts go where a startup log is read.
    const { events, actions, integrations } = extensions.catalog;
    getAppLogger("extensions").info(
      `Extension surface assembled: ${events.length} events, ${actions.length} actions, ${integrations.length} integrations`
    );

    persistence = await options.persistence.open(cipher);
    getAppLogger("persistence").info("Persistence configured", {
      persistence: persistence.description,
    });

    // The Layer graph this instance owns. Building it is lazy, so an app that
    // never serves a migrated procedure never constructs a service.
    runtime = createWfGraphRuntime({
      inngest,
      extensions,
      appContext: {
        ...(publicUrl ? { publicUrl } : {}),
        apiBasePath: `${basePath}/api`,
      },
      agent: readAgentSettings(options.agent),
      repositories: persistence.repositories,
    });

    return await assembleWfGraphApp(options, {
      basePath,
      publicUrl,
      authorize,
      runtime,
      inngest,
      persistence,
    });
  } catch (error) {
    return await failAfterClose(error, [
      async () => await runtime?.dispose(),
      async () => await persistence?.close(),
    ]);
  }
}

/** Everything after the runtime exists: the routes, the editor, and dispose. */
async function assembleWfGraphApp(
  options: WfGraphAppOptions,
  startup: {
    basePath: "" | `/${string}`;
    publicUrl?: string;
    authorize: Authorize;
    runtime: WfGraphRuntime;
    inngest: InngestSurface;
    persistence: WfGraphPersistenceInstance;
  }
): Promise<WfGraphApp> {
  const { basePath, publicUrl, authorize, runtime, inngest, persistence } =
    startup;

  // Built once: Connect and HTTP serve are alternatives, and whichever path
  // this app takes registers that same list. A broken extension surface fails
  // at boot instead of on the first request or Connect handshake.
  const functions = await buildInngestFunctions(inngest.client, runtime);
  const useConnect = options.inngest.connect === true;
  const apiApp = createApiApp({
    basePath: `${basePath}/api`,
    publicUrl,
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

    await closeInOrder([
      () => runtime.dispose(),
      // Last, because a Layer finalizer is free to use persistence while closing.
      persistence.close,
    ]);
  };

  return {
    fetch: async (request) => await fullApp.fetch(request),
    basePath,
    dispose,
  };
}
