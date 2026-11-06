import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { Hono } from "hono";
import { createApiApp } from "#src/backend/api-app";
import {
  assertValidEncryptionKey,
  type EncryptionRuntimeConfig,
} from "#src/backend/services/integrations/cipher";
import {
  type ResolvedAuth,
  resolveAuth,
  type WfGraphAuth,
  UNAUTHORIZED_BODY,
} from "#src/backend/lib/http/authorize";
import { serveClientAsset } from "#src/backend/lib/http/client-assets";
import {
  normalizeBasePath,
  toMountRelativePath,
} from "#src/backend/lib/http/mount-path";
import type { WfGraphExtensions } from "#src/backend/extensions/extension-set";
import { getAppLogger } from "#src/backend/lib/logger";
import {
  readAgentSettings,
  type WfGraphAgentConfig,
} from "#src/backend/agent/config";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import type { WfGraphLogger } from "@wfgraph/shared/types/logger";
import { failAfterClose } from "#src/backend/lib/close-in-order";
import { resolvePublicUrl } from "#src/backend/lib/http/public-url";
import type {
  InProcessRunner,
  WfGraphRunnerOptions,
} from "#src/backend/executor/in-process-runner";
import { openWfGraphSetup, type WfGraphSetup } from "#src/backend/setup";
import type { WfGraphMcpOptions } from "#src/backend/agent/mcp-server";
import type {
  WfGraphEvents,
  WfGraphEventsOptions,
} from "#src/backend/host-events";
import { isBlank } from "@wfgraph/shared/types/string";

export type { EncryptionRuntimeConfig } from "#src/backend/services/integrations/cipher";
export {
  defineWfGraphAuth,
  trustWfGraphUpstream,
  WfGraphAccess,
  WfGraphRoles,
  type WfGraphAuth,
} from "#src/backend/lib/http/authorize";
export type { WfGraphLogger } from "@wfgraph/shared/types/logger";
export type { WfGraphExtensions } from "#src/backend/extensions/extension-set";
export type { WfGraphPersistence } from "#src/backend/persistence/types";
export type { WfGraphMcpOptions } from "#src/backend/agent/mcp-server";
export type { WfGraphRunnerOptions } from "#src/backend/executor/in-process-runner";
export {
  WfGraphEventRefused,
  type WfGraphEventInput,
  type WfGraphEventReceipt,
  type WfGraphEvents,
  type WfGraphEventsOptions,
} from "#src/backend/host-events";

export type WfGraphAppOptions = {
  /**
   * Absolute path the host mounted Workflow Graph at, for example "/workflows". Defaults
   * to "/". Workflow Graph builds its API prefix, its asset URLs, and the SPA's
   * `<base href>` from this, so a host that mounts under a sub-path says so
   * once here instead of Workflow Graph guessing per request.
   */
  basePath?: string | undefined;
  /** Public origin used in provider callback URLs and client metadata. */
  publicUrl?: string | undefined;
  /**
   * Authenticates operators and returns their request-scoped access policy.
   * Use `trustWfGraphUpstream()` only when an upstream boundary authenticates
   * and authorizes every operator request.
   *
   * Required everywhere rather than only in production, because the check that
   * would tell the two apart reads an environment variable that says
   * "production" and misses "prod" and an unset one. Covers everything Workflow
   * Graph serves except machine routes (`/webhooks/:type/:connectionId` and
   * `/events` when `events.key` is set) and public OAuth client metadata at
   * `/integrations/oauth/clients/:integrationType`.
   */
  auth: WfGraphAuth;
  /**
   * Where Workflow Graph's own log lines go. Absent, Workflow Graph configures a console sink of
   * its own; present, every line is handed to this instead.
   */
  logger?: WfGraphLogger | undefined;
  /** The storage backend Workflow Graph uses for all durable state. */
  persistence: WfGraphPersistence;
  /**
   * Maximum time in milliseconds for one call to a host-owned Entity resolver.
   * Defaults to 10,000. A timeout is an operational failure.
   */
  entityResolverTimeoutMs?: number | undefined;
  encryption: EncryptionRuntimeConfig;
  /** Event intake over HTTP. See `WfGraphEventsOptions`. */
  events?: WfGraphEventsOptions | undefined;
  /**
   * The worker loop that advances workflow runs stored in `persistence`.
   *
   * Left out, the app runs one loop in its own process with the backend's
   * defaults. An object runs that loop with the fields it sets, and `false`
   * runs none, for a host that advances runs in another process with
   * `createWfGraphRunner`. SQLite refuses `false`, since no other process can
   * share its file. Dispose stops the loop and waits up to ten seconds for the
   * runs it is advancing.
   */
  runner?: false | WfGraphRunnerOptions | undefined;
  /**
   * The whole extension surface, in one place.
   *
   * Nothing registers itself, so what is listed here is what this app has: an
   * integration brings its actions, its steps and its connection test with it, an
   * Event brings its payload schema, and a `defineAction` brings its handler.
   * Dropping a line is what turns something off.
   */
  extensions?: WfGraphExtensions | undefined;
  /**
   * The build agent: the chat panel in the editor that reads the catalog and
   * edits the open workflow.
   *
   * Absent, or with a blank `apiKey`, the agent is off: no model is called, and
   * the editor shows no chat panel. A host passes its own key, conventionally
   * `process.env.OPENAI_API_KEY`.
   */
  agent?: WfGraphAgentConfig | undefined;
  /** Enables the authenticated stateless MCP endpoint at `${basePath}/api/mcp`. */
  mcp?: true | WfGraphMcpOptions | undefined;
  /**
   * The workflow editor, from `import { clientBundle } from "@wfgraph/client"`.
   *
   * Workflow Graph serves the editor when a host hands it one and serves nothing when they
   * do not, so turning the UI on is a line in the host's code rather than a
   * consequence of what happens to be installed. `@wfgraph/core` does not depend on
   * `@wfgraph/client` in either direction.
   */
  client?: WfGraphClientBundle | undefined;
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
  /** Raises an Event into this app's event inbox from the host's own code. */
  events: WfGraphEvents;
  /**
   * Give back everything this app holds. Awaiting it waits for the worker
   * loop to stop and for the Effect runtime's Layers to finalize; a host that
   * fires and forgets still releases the registrations synchronously.
   */
  dispose: () => Promise<void>;
  /** Dispose the app automatically when an `await using` scope exits. */
  [Symbol.asyncDispose]: () => Promise<void>;
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
  const auth = resolveAuth(options.auth);

  assertValidEncryptionKey(options.encryption.key);
  const eventsKey = options.events?.key;
  if (eventsKey !== undefined && isBlank(eventsKey)) {
    throw new Error(
      "createWfGraphApp's events.key is blank. Pass a secret to mount POST /api/events, or leave the key out to keep that route off."
    );
  }
  // A sender presents the key as one Bearer token, which holds no whitespace,
  // so a key with any could never be presented.
  if (eventsKey !== undefined && /\s/u.test(eventsKey)) {
    throw new Error(
      "createWfGraphApp's events.key contains whitespace, which an Authorization: Bearer header cannot carry. Pass a key without spaces, tabs or line breaks."
    );
  }

  const setup = await openWfGraphSetup({
    logger: options.logger,
    persistence: options.persistence,
    encryption: options.encryption,
    extensions: options.extensions,
    entityResolverTimeoutMs: options.entityResolverTimeoutMs,
    basePath,
    publicUrl,
    agent: readAgentSettings(options.agent),
    caller: "createWfGraphApp",
    runner: options.runner,
    retentionMs: options.events?.retentionMs,
  });

  // Everything past this point can fail with persistence already open, and
  // with whatever the Layers acquired. A failure gives both back, the same as
  // dispose does, so a host that catches a startup failure, corrects an option
  // and calls again is not refused as a rebind.
  try {
    if (options.runner === false && setup.capabilities.processes === "one") {
      throw new Error(
        "createWfGraphApp cannot take runner: false on this persistence backend: no other process can share its database, so this app's own loop is the only one that can advance its runs"
      );
    }
    return await assembleWfGraphApp(options, {
      basePath,
      auth,
      setup,
    });
  } catch (error) {
    return await failAfterClose(error, [setup.close]);
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
      `createWfGraphApp's client.dir does not hold an index.html: looked for ${entry}. Pass clientBundle from @wfgraph/client, or the directory of your own build of the editor.`
    );
  }
}

/** Everything after the runtime exists: the routes, the editor, and dispose. */
async function assembleWfGraphApp(
  options: WfGraphAppOptions,
  startup: {
    basePath: "" | `/${string}`;
    auth: ResolvedAuth;
    setup: WfGraphSetup;
  }
): Promise<WfGraphApp> {
  const { basePath, auth, setup } = startup;
  const { runtime } = setup;
  const { startRunner } = setup;

  // The runtime's first Effect builds the Layer graph, so a graph that cannot
  // build fails at boot instead of on the first request.
  await runtime.runPromise(Effect.void);
  const apiApp = createApiApp({
    basePath: `${basePath}/api`,
    auth,
    runtime,
    mcp: options.mcp,
    eventsKey: options.events?.key,
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
      let authContext;
      try {
        authContext = await auth.authenticate(c.req.raw, (failure) => {
          getAppLogger("http", "auth").error(
            failure.stage === "authenticate"
              ? "Host authentication failed"
              : "Host access policy failed",
            { error: failure.error }
          );
        });
      } catch {
        return c.json({ error: "Internal Server Error" }, 500);
      }
      if (!authContext) return c.json(UNAUTHORIZED_BODY, 401);

      return await serveClientAsset({ clientDir, basePath, pathname });
    });
  }

  // Last, so a boot that failed before this line leaves no loop running.
  let runner: InProcessRunner | undefined = startRunner?.();

  const disposeOnce = async (): Promise<void> => {
    // The loop's passes write through the runtime and the backend, so it
    // stops, its passes drained, before either closes.
    await runner?.stop();
    runner = undefined;

    await setup.close();
  };
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => (disposal ??= disposeOnce());

  return {
    fetch: async (request) => await fullApp.fetch(request),
    basePath,
    events: setup.events,
    dispose,
    [Symbol.asyncDispose]: dispose,
  };
}
