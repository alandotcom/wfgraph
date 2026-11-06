/**
 * The Cloudflare Worker host. Every invocation opens the persistence backend,
 * builds a runtime on it, and closes both before it ends: `fetch` serves the
 * API, and `scheduled` (a Cron Trigger) and `queue` (a run wake on the host's
 * Queue) each run one tick of the database executor. A tick's budget, its
 * releases and its closes all end under the 15-minute wall time Cloudflare
 * gives a Cron Trigger or a Queue consumer invocation, and its pass limit
 * keeps it under the invocation's CPU time. A run whose invocation was killed
 * anyway is claimed again once its lease expires.
 */

import { Effect } from "effect";
import { generateId } from "@wfgraph/shared/utils/id";
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
  assertValidRetentionMs,
  resolveTickSettings,
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
import { sum } from "es-toolkit/math";
import { mapKeys } from "es-toolkit/object";
import {
  readAgentSettings,
  type WfGraphAgentConfig,
} from "#src/backend/agent/config";
import type { WfGraphRuntime } from "#src/backend/runtime";
import { openWfGraphRuntime } from "#src/backend/setup";
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
 * Trigger or a Queue consumer invocation. The tick waits at most 30 seconds
 * past it for the releases of the passes it cut, and closing the connection
 * waits at most five more, which leaves the rest of the minute for the tick's
 * record.
 */
const WORKER_TICK_BUDGET_MS = 14 * 60 * 1000;

/**
 * How many passes one tick runs before it stops claiming. Cloudflare limits
 * the CPU time of a Queue consumer invocation to 30 seconds by default, and of
 * a Cron Trigger firing more often than hourly to 30 seconds outright, summed
 * over the whole invocation. Time spent waiting on the database or an
 * action's requests does not count, so 100 passes leave each about 300 ms of
 * CPU time for replaying its run.
 */
const WORKER_TICK_PASS_LIMIT = 100;

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
   * `createWfGraphApp`. Each Cron Trigger tick sweeps with `retentionMs`.
   */
  events?: WfGraphEventsOptions | undefined;
  /**
   * The Queue producer binding that carries run wakes, such as
   * `env.WFGRAPH_WAKES`, whose consumer is this Worker's `queue` handler.
   * With it, a write `fetch` makes that makes a run or a delivery due sends a
   * message, and the consumer runs a tick at once. A tick sends none: a row
   * its own passes make due is claimed by its next drain step. Without it, the
   * Cron Trigger's tick each minute is the only one, so an Event is delivered,
   * and a run started or woken, up to a minute after the write.
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
 * The part of Cloudflare's `ExecutionContext` the `fetch` handler reads.
 * `waitUntil` keeps the invocation alive for a promise after the response is
 * sent, for up to 30 seconds.
 */
export type WfGraphExecutionContext = {
  readonly waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * The Worker's handlers, shaped so the object is the module's default export.
 * A host that routes other traffic, crons or queues through the same Worker
 * calls these from its own handlers.
 */
export type WfGraphWorker<Env> = {
  /**
   * Serves Workflow Graph's API. The invocation's closes run after the
   * response, through `context.waitUntil`, except for an event stream's, which
   * run when the stream ends.
   */
  fetch: (
    request: Request,
    env: Env,
    context: WfGraphExecutionContext
  ) => Promise<Response>;
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

/** What one invocation opened, and the close that gives it back. */
type Invocation = {
  runtime: WfGraphRuntime;
  extensions: ExtensionSet;
  capabilities: WfGraphRunCapabilities;
  close: () => Promise<void>;
};

/** What started a tick, which its worker id and its record name. */
type TickTrigger = "cron" | "queue";

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

  /**
   * Opens one invocation. Only `fetch` passes `wakeQueue`: a tick's own
   * passes need no Queue message, since its next drain step claims the rows
   * they make due, and a message would start an overlapping invocation that
   * finds nothing.
   */
  const open = async (
    env: Env,
    config: WfGraphWorkerRequestConfig,
    wakeQueue: WfGraphWakeQueue | undefined
  ): Promise<Invocation> => {
    assertValidEncryptionKey(config.encryption.key);
    assertValidEventsKey(config.events?.key, "wfWorker");
    assertValidRetentionMs(config.events?.retentionMs, "wfWorker");
    const extensions =
      staticExtensions ??
      assembleExtensions(extensionResolver?.(env) ?? {}, {
        entityResolverTimeoutMs,
      });
    const agent = readAgentSettings(config.agent);
    const cipher = createIntegrationCipher(config.encryption);
    const persistence = await config.persistence.open(cipher);
    const wake =
      wakeQueue === undefined ? undefined : createQueueWake(wakeQueue);
    const { runtime, close } = await openWfGraphRuntime({
      persistence,
      extensions,
      appContext: { publicUrl, apiBasePath: `${basePath}/api` },
      agent,
      wakes: wake === undefined ? [] : [wake],
      // A wake whose send the close cut off would be lost.
      settleWakes: wake?.settled,
    });
    return {
      runtime,
      extensions,
      capabilities: persistence.capabilities,
      close,
    };
  };

  /**
   * One tick on its own invocation, which writes one record: `logTick`'s, or
   * an error record when opening, the tick or the close failed, before the
   * failure is rethrown so the platform sees it.
   */
  const runTick = async (
    env: Env,
    trigger: TickTrigger,
    detail: Record<string, string | number>
  ): Promise<void> => {
    const startedAt = Date.now();
    const workerId = `cf-worker:${trigger}:${generateId()}`;
    const tickFields = { trigger, worker: workerId, ...detail };
    let outcome: TickOutcome | undefined;
    try {
      const config = options.request(env);
      const invocation = await open(env, config, undefined);
      const { runtime, extensions, capabilities } = invocation;
      const settings = resolveTickSettings(
        capabilities,
        config.events?.retentionMs
      );
      await runWithClose(async () => {
        outcome = await runtime.runPromise(
          tick({
            // Built per pass, so a decrypted credential lives as long as its pass.
            actions: () => createWorkflowActions(extensions, runtime),
            entities: createWorkflowEntities(extensions),
            ...settings,
            workerId,
            leaseMs: WORKER_LEASE_MS,
            heartbeatMs: WORKER_HEARTBEAT_MS,
            budgetMs: WORKER_TICK_BUDGET_MS,
            claimWindowMs: WORKER_TICK_CLAIM_WINDOW_MS,
            passLimit: WORKER_TICK_PASS_LIMIT,
            // Only the Cron Trigger's tick sweeps: once a minute is enough,
            // and a Queue tick stays as short as its wake.
            sweep: trigger === "cron",
          }).pipe(
            Effect.withSpan("wfgraph.worker.tick", {
              attributes: {
                "wfgraph.worker.trigger": trigger,
                "wfgraph.executor.worker": workerId,
                ...mapKeys(detail, (_value, key) => `wfgraph.worker.${key}`),
              },
            })
          )
        );
      }, [invocation.close]);
    } catch (error) {
      logger.error("Tick failed", {
        tick: { ...tickFields, ms: Date.now() - startedAt },
        outcome,
        error,
      });
      throw error;
    }
    if (outcome !== undefined) {
      logTick(outcome, { ...tickFields, ms: Date.now() - startedAt });
    }
  };

  return {
    fetch: async (request, env, context) => {
      const config = options.request(env);
      const auth = resolveAuth(config.auth);
      const invocation = await open(env, config, config.wakeQueue);
      return await runWithResponseClose(
        async () =>
          await createApiApp({
            basePath: `${basePath}/api`,
            auth,
            runtime: invocation.runtime,
            mcp: options.mcp,
            eventsKey: config.events?.key,
          }).fetch(request),
        [invocation.close],
        {
          defer: (close) => {
            context.waitUntil(
              close().catch((error: unknown) => {
                logger.error(
                  "Could not close a request's runtime and persistence",
                  { error }
                );
              })
            );
          },
        }
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
 * Cron Trigger runs one every minute, and a tick that cut a pass logs at warn.
 */
function logTick(
  outcome: TickOutcome,
  tickFields: Record<string, string | number>
): void {
  const fields = {
    tick: { ...tickFields, stopped: outcome.stopped },
    passes: outcome.passes,
    results: outcome.results,
  };
  const { results } = outcome;
  if (results.cut > 0) {
    logger.warn("Tick finished; its budget cut a pass", fields);
  } else if (sum(Object.values(results)) === 0) {
    logger.debug("Tick found nothing due", fields);
  } else {
    logger.info("Tick finished", fields);
  }
}
