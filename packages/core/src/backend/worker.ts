import { Hono } from "hono";
import { createApiApp } from "#src/backend/api-app";
import {
  assembleExtensions,
  type WfGraphExtensions,
} from "#src/backend/extensions/extension-set";
import {
  assertValidEncryptionKey,
  createIntegrationCipher,
  type EncryptionRuntimeConfig,
} from "#src/backend/services/integrations/cipher";
import { resolveAuth, type WfGraphAuth } from "#src/backend/lib/http/authorize";
import { normalizeBasePath } from "#src/backend/lib/http/mount-path";
import {
  createInngestSurface,
  type InngestSurfaceDeps,
  type WfGraphInngestConfig,
} from "#src/backend/lib/inngest/client";
import { buildInngestFunctions } from "#src/backend/lib/inngest/functions";
import {
  configureLoggingWithBridge,
  warnWhenLoggingUnconfigured,
} from "#src/backend/lib/log-config";
import {
  readAgentSettings,
  type WfGraphAgentConfig,
} from "#src/backend/agent/config";
import { createWfGraphRuntime } from "#src/backend/runtime";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import type { WfGraphLogger } from "@wfgraph/shared/types/logger";
import { runWithClose } from "#src/backend/lib/close-in-order";
import { resolvePublicUrl } from "#src/backend/lib/http/public-url";

export type WfGraphWorkerRequestConfig = {
  auth: WfGraphAuth;
  persistence: WfGraphPersistence;
  encryption: EncryptionRuntimeConfig;
  inngest: WfGraphInngestConfig;
  /**
   * The build agent's model settings. Per request like every other secret here,
   * because a Worker reads its bindings from the environment it was invoked
   * with.
   */
  agent?: WfGraphAgentConfig | undefined;
};

export type WfGraphWorkerOptions<Env> = {
  basePath?: string | undefined;
  /** Public origin used in provider callback URLs and client metadata. */
  publicUrl?: string | undefined;
  logger?: WfGraphLogger | undefined;
  extensions?:
    | WfGraphExtensions
    | ((env: Env) => WfGraphExtensions)
    | undefined;
  /** Resolve bindings and secrets for this request's Worker environment. */
  request: (env: Env) => WfGraphWorkerRequestConfig;
};

export type WfGraphWorker<Env> = {
  fetch: (request: Request, env: Env) => Promise<Response>;
};

const refuseConnect: InngestSurfaceDeps["connect"] = () => {
  throw new Error("Inngest Connect is unavailable in the Worker host");
};

/**
 * Build a Cloudflare Worker fetch handler with request-scoped persistence.
 *
 * This entry serves Workflow Graph's API and Inngest callback. Static assets stay
 * with the Worker's Assets binding or the host's own router.
 */
export function wfWorker<Env>(
  options: WfGraphWorkerOptions<Env>
): WfGraphWorker<Env> {
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const publicUrl = resolvePublicUrl(options.publicUrl);
  const extensionsOption = options.extensions;
  const extensionResolver =
    typeof extensionsOption === "function" ? extensionsOption : undefined;
  const staticExtensions =
    typeof extensionsOption === "function"
      ? undefined
      : assembleExtensions(extensionsOption ?? {});

  if (options.logger) configureLoggingWithBridge(options.logger);
  else warnWhenLoggingUnconfigured();

  return {
    fetch: async (request, env) => {
      const config = options.request(env);
      if (config.inngest.connect === true) {
        throw new Error("wfWorker does not support inngest.connect");
      }
      if (!config.inngest.id?.trim()) {
        throw new Error("wfWorker requires inngest.id");
      }
      assertValidEncryptionKey(config.encryption.key);

      const extensions =
        staticExtensions ?? assembleExtensions(extensionResolver?.(env) ?? {});

      const auth = resolveAuth(config.auth);
      const cipher = createIntegrationCipher(config.encryption);
      const persistence = await config.persistence.open(cipher);
      let runtime: ReturnType<typeof createWfGraphRuntime> | undefined;

      return runWithClose(async () => {
        const inngest = createInngestSurface(config.inngest, {
          connect: refuseConnect,
        });
        runtime = createWfGraphRuntime({
          inngest,
          extensions,
          appContext: {
            publicUrl,
            apiBasePath: `${basePath}/api`,
          },
          agent: readAgentSettings(config.agent),
          repositories: persistence.repositories,
        });
        const functions = await buildInngestFunctions(inngest.client, runtime);
        const app = new Hono();
        app.route(
          "/",
          createApiApp({
            basePath: `${basePath}/api`,
            auth,
            runtime,
            inngestHandler: inngest.serve(functions),
          })
        );
        return await app.fetch(request);
      }, [async () => await runtime?.dispose(), persistence.close]);
    },
  };
}
