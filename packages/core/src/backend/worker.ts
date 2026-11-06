/**
 * The Cloudflare Worker host. Every invocation opens the persistence backend,
 * builds a runtime on it, and closes both before it ends: `fetch` serves the
 * API, and `scheduled` (a Cron Trigger) and `queue` (a run wake on the host's
 * Queue) each run one tick of the database executor. A tick's budget sits
 * under the 15-minute wall time Cloudflare gives a Cron Trigger or a Queue
 * consumer invocation, and a run its invocation lost is claimed again once its
 * lease expires.
 */

import { createApiApp } from "#src/backend/api-app";
import {
  assembleExtensions,
  type ExtensionSet,
  type WfGraphExtensions,
} from "#src/backend/extensions/extension-set";
import { readEntityResolverTimeoutMs } from "#src/backend/extensions/entity-resolution";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { createWorkflowEntities } from "#src/backend/extensions/workflow-entities";
import {
  assertValidRunnerOptions,
  DEFAULT_DELIVERY_CONCURRENCY,
  DEFAULT_INBOX_RETENTION_MS,
} from "#src/backend/executor/in-process-runner";
import {
  createQueueWake,
  type WfGraphWakeQueue,
} from "#src/backend/executor/queue-wake";
import { tick, type TickOutcome } from "#src/backend/executor/worker-loop";
import {
  assertValidEventsKey,
  type WfGraphEventsOptions,
} from "#src/backend/host-events";
import {
  assertValidEncryptionKey,
  createIntegrationCipher,
  type EncryptionRuntimeConfig,
} from "#src/backend/services/integrations/cipher";
import { resolveAuth, type WfGraphAuth } from "#src/backend/lib/http/authorize";
import { normalizeBasePath } from "#src/backend/lib/http/mount-path";
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
  WfGraphRunCapabilities,
} from "#src/backend/persistence/types";
import type { WfGraphLogger } from "@wfgraph/shared/types/logger";
import {
  runWithClose,
  runWithResponseClose,
} from "#src/backend/lib/close-in-order";
import { resolvePublicUrl } from "#src/backend/lib/http/public-url";
import type { WfGraphMcpOptions } from "#src/backend/agent/mcp-server";

export type { WfGraphMcpOptions } from "#src/backend/agent/mcp-server";

/**
 * How long one tick may run: a minute under the 15-minute wall time of a Cron
 * Trigger or a Queue consumer invocation, which leaves the minute for the
 * releases of interrupted passes and for closing the connection.
 */
const WORKER_TICK_BUDGET_MS = 14 * 60 * 1000;

/**
 * How long after a tick starts it may claim more rows, so a pass it claims
 * last still has four minutes before the budget interrupts it.
 */
const WORKER_TICK_CLAIM_WINDOW_MS = 10 * 60 * 1000;

/**
 * The lease a tick takes on each row it claims: a third of the platform's
 * 15-minute wall time, so a run whose invocation was killed is claimed again
 * by a tick within five minutes and a cron interval.
 */
const WORKER_LEASE_MS = 5 * 60 * 1000;

/** How often a tick's pass renews its lease while a step runs: five per lease. */
const WORKER_HEARTBEAT_MS = 60 * 1000;

export type WfGraphWorkerRequestConfig = {
  auth: WfGraphAuth;
  persistence: WfGraphPersistence;
  encryption: EncryptionRuntimeConfig;
  /**
   * The build agent's model settings. Read per invocation like every other
   * secret here, because a Worker reads its bindings from the environment it
   * was invoked with.
   */
  agent?: WfGraphAgentConfig | undefined;
  /**
   * Event intake over HTTP and the settled-row window, as on
   * `createWfGraphApp`. Every tick sweeps with `retentionMs`.
   */
  events?: WfGraphEventsOptions | undefined;
  /**
   * The Queue producer binding that carries run wakes, such as
   * `env.WFGRAPH_WAKES`, whose consumer is this Worker's `queue` handler.
   * With it, a write that makes a run or a delivery due sends a message, and
   * the consumer runs a tick at once. Without it, the Cron Trigger's tick each
   * minute is the only one, so an Event is delivered, and a run started or
   * woken, up to a minute after the write.
   */
  wakeQueue?: WfGraphWakeQueue | undefined;
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
  /**
   * Resolve bindings and secrets from the Worker environment. Called once per
   * invocation of `fetch`, `scheduled` and `queue`.
   */
  request: (env: Env) => WfGraphWorkerRequestConfig;
};

/** The part of Cloudflare's `ScheduledController` the `scheduled` handler reads. */
export type WfGraphScheduledController = { readonly cron: string };

/** The part of Cloudflare's `MessageBatch` the `queue` handler reads. */
export type WfGraphWakeBatch = { readonly messages: readonly unknown[] };

/**
 * The Worker's handlers, shaped so the object is the module's default export.
 * A host that routes other traffic, crons or queues through the same Worker
 * calls these from its own handlers.
 */
export type WfGraphWorker<Env> = {
  /** Serves Workflow Graph's API. */
  fetch: (request: Request, env: Env) => Promise<Response>;
  /** Runs one tick, for the host's Cron Trigger. */
  scheduled: (
    controller: WfGraphScheduledController,
    env: Env
  ) => Promise<void>;
  /**
   * Runs one tick for a batch of run wakes, whatever the batch holds, since a
   * wake names no row. A batch whose tick could not open the database fails,
   * so the Queue retries it.
   */
  queue: (batch: WfGraphWakeBatch, env: Env) => Promise<void>;
};

/** What one invocation opened, and the closes that give it back in order. */
type Invocation = {
  runtime: WfGraphRuntime;
  extensions: ExtensionSet;
  capabilities: WfGraphRunCapabilities;
  closes: readonly (() => Promise<void>)[];
};

const logger = getAppLogger("executor");

/**
 * Build a Cloudflare Worker whose `fetch` serves Workflow Graph's API with
 * per-invocation persistence and whose `scheduled` and `queue` handlers run
 * workflows. Static assets stay with the Worker's Assets binding or the
 * host's own router.
 */
export function wfWorker<Env>(
  options: WfGraphWorkerOptions<Env>
): WfGraphWorker<Env> {
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const publicUrl = resolvePublicUrl(options.publicUrl);
  const entityResolverTimeoutMs = readEntityResolverTimeoutMs(
    options.entityResolverTimeoutMs
  );
  const extensionsOption = options.extensions;
  const extensionResolver =
    typeof extensionsOption === "function" ? extensionsOption : undefined;
  const staticExtensions =
    typeof extensionsOption === "function"
      ? undefined
      : assembleExtensions(extensionsOption ?? {}, {
          entityResolverTimeoutMs,
        });

  if (options.logger) configureLoggingWithBridge(options.logger);
  else warnWhenLoggingUnconfigured();

  const open = async (
    env: Env,
    config: WfGraphWorkerRequestConfig
  ): Promise<Invocation> => {
    assertValidEncryptionKey(config.encryption.key);
    assertValidEventsKey(config.events?.key, "wfWorker");
    assertValidRunnerOptions({
      runner: undefined,
      retentionMs: config.events?.retentionMs,
      caller: "wfWorker",
    });
    const extensions =
      staticExtensions ??
      assembleExtensions(extensionResolver?.(env) ?? {}, {
        entityResolverTimeoutMs,
      });
    const cipher = createIntegrationCipher(config.encryption);
    const persistence = await config.persistence.open(cipher);
    const wake =
      config.wakeQueue === undefined
        ? undefined
        : createQueueWake(config.wakeQueue);
    const runtime = createWfGraphRuntime({
      extensions,
      appContext: { publicUrl, apiBasePath: `${basePath}/api` },
      agent: readAgentSettings(config.agent),
      repositories: persistence.repositories,
      wakes: wake === undefined ? [] : [wake],
    });
    return {
      runtime,
      extensions,
      capabilities: persistence.capabilities,
      closes: [
        // The sends first, since a wake whose send is cut off is lost.
        async () => await wake?.settled(),
        () => runtime.dispose(),
        persistence.close,
      ],
    };
  };

  const runTick = async (
    env: Env,
    trigger: "cron" | "queue",
    detail: Record<string, string | number>
  ): Promise<void> => {
    const config = options.request(env);
    const invocation = await open(env, config);
    const { runtime, extensions, capabilities } = invocation;
    await runWithClose(async () => {
      const startedAt = Date.now();
      const outcome = await runtime.runPromise(
        tick({
          // Built per pass, so a decrypted credential lives as long as its pass.
          actions: () => createWorkflowActions(extensions, runtime),
          entities: createWorkflowEntities(extensions),
          concurrency: Math.min(
            capabilities.loopDefaults.concurrency,
            capabilities.connectionLimit
          ),
          deliveryConcurrency: DEFAULT_DELIVERY_CONCURRENCY,
          leaseMs: WORKER_LEASE_MS,
          heartbeatMs: WORKER_HEARTBEAT_MS,
          retentionMs: config.events?.retentionMs ?? DEFAULT_INBOX_RETENTION_MS,
          budgetMs: WORKER_TICK_BUDGET_MS,
          claimWindowMs: WORKER_TICK_CLAIM_WINDOW_MS,
        })
      );
      logTick(outcome, {
        trigger,
        ...detail,
        ms: Date.now() - startedAt,
      });
    }, invocation.closes);
  };

  return {
    fetch: async (request, env) => {
      const config = options.request(env);
      const auth = resolveAuth(config.auth);
      const invocation = await open(env, config);
      return await runWithResponseClose(
        async () =>
          await createApiApp({
            basePath: `${basePath}/api`,
            auth,
            runtime: invocation.runtime,
            mcp: options.mcp,
            eventsKey: config.events?.key,
          }).fetch(request),
        invocation.closes
      );
    },
    scheduled: async (controller, env) => {
      await runTick(env, "cron", { cron: controller.cron });
    },
    queue: async (batch, env) => {
      await runTick(env, "queue", { messages: batch.messages.length });
    },
  };
}

/**
 * One record per tick. A tick that found nothing due logs at debug, since the
 * Cron Trigger runs one every minute.
 */
function logTick(
  outcome: TickOutcome,
  tickFields: Record<string, string | number>
): void {
  const fields = { tick: { ...tickFields, ...outcome } };
  if (outcome.passed + outcome.failed + outcome.interrupted === 0) {
    logger.debug("Tick found nothing due", fields);
  } else {
    logger.info("Tick finished", fields);
  }
}
