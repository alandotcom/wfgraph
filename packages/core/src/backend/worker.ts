import type { WfGraphExtensions } from "#src/backend/extensions/extension-set";
import type { EncryptionRuntimeConfig } from "#src/backend/services/integrations/cipher";
import type { WfGraphAuth } from "#src/backend/lib/http/authorize";
import type { WfGraphAgentConfig } from "#src/backend/agent/config";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import type { WfGraphLogger } from "@wfgraph/shared/types/logger";
import type { WfGraphMcpOptions } from "#src/backend/agent/mcp-server";

export type { WfGraphMcpOptions } from "#src/backend/agent/mcp-server";

export type WfGraphWorkerRequestConfig = {
  auth: WfGraphAuth;
  persistence: WfGraphPersistence;
  encryption: EncryptionRuntimeConfig;
  /**
   * The build agent's model settings. Per request like every other secret here,
   * because a Worker reads its bindings from the environment it was invoked
   * with.
   */
  agent?: WfGraphAgentConfig | undefined;
};

export type WfGraphWorkerOptions<Env> = {
  basePath?: string | undefined;
  /**
   * Maximum time in milliseconds for one call to a host-owned Entity resolver.
   * Defaults to 10,000. A timeout is an operational failure.
   */
  entityResolverTimeoutMs?: number | undefined;
  /** Enables the authenticated stateless MCP endpoint at `${basePath}/api/mcp`. */
  mcp?: true | WfGraphMcpOptions | undefined;
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

/** What `wfWorker` throws, naming why a Worker cannot run workflows yet. */
const WORKER_RUNS_UNAVAILABLE =
  "wfWorker cannot start: workflow runs execute on the database executor's worker loop, which needs a long-lived process, and the Cloudflare Worker backend runs it once its tick driver ships. Run Workflow Graph with createWfGraphApp on Node until then.";

/**
 * The Cloudflare Worker host. It refuses to start, at the module evaluation
 * that builds the handler, because a Worker invocation has no long-lived
 * process to run the database executor's worker loop in. Workflow runs on the
 * Worker backend arrive with its tick driver.
 */
export function wfWorker<Env>(
  _options: WfGraphWorkerOptions<Env>
): WfGraphWorker<Env> {
  throw new Error(WORKER_RUNS_UNAVAILABLE);
}
