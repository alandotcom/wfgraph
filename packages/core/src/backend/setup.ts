/**
 * What `createWfGraphApp` and `createWfGraphRunner` both stand on: the worker
 * loop's settings, logging, the cipher, the extension surface, the opened
 * persistence backend, the app's run wakes, the runtime whose
 * `ExecutionDriver` announces to them, and the host's Event send over that
 * runtime. `openWfGraphRuntime`, the runtime over an opened backend, is also
 * what each `wfWorker` invocation stands on. The loop's options are refused
 * before anything opens. A failure while opening gives back whatever was
 * acquired. `close` disposes the runtime and then closes the backend, so the
 * runner must stop first.
 */

import { Effect } from "effect";
import type { AgentSettings } from "#src/backend/agent/config";
import {
  assembleExtensions,
  type ExtensionSet,
  type WfGraphExtensions,
} from "#src/backend/extensions/extension-set";
import {
  assertValidRunnerOptions,
  type InProcessRunner,
  resolveRunnerSettings,
  startInProcessRunner,
  type WfGraphRunnerOptions,
} from "#src/backend/executor/in-process-runner";
import { createAppRunWakes } from "#src/backend/executor/worker-wake";
import { createHostEvents, type WfGraphEvents } from "#src/backend/host-events";
import type { RetentionWindows } from "#src/backend/host-retention";
import { closeInOrder, failAfterClose } from "#src/backend/lib/close-in-order";
import {
  configureLoggingWithBridge,
  warnWhenLoggingUnconfigured,
} from "#src/backend/lib/log-config";
import { getAppLogger } from "#src/backend/lib/logger";
import type {
  WfGraphPersistence,
  WfGraphPersistenceInstance,
  WfGraphRunCapabilities,
} from "#src/backend/persistence/types";
import {
  createWfGraphRuntime,
  type WfGraphRuntime,
  type WfGraphRuntimeParts,
} from "#src/backend/runtime";
import { overdueAfterMs } from "#src/backend/services/executions/executor-state";
import {
  createIntegrationCipher,
  type EncryptionRuntimeConfig,
} from "#src/backend/services/integrations/cipher";
import type { WfGraphLogger } from "@wfgraph/shared/types/logger";

export type WfGraphSetupOptions = {
  logger?: WfGraphLogger | undefined;
  persistence: WfGraphPersistence;
  encryption: EncryptionRuntimeConfig;
  extensions?: WfGraphExtensions | undefined;
  entityResolverTimeoutMs?: number | undefined;
  /** The normalized mount path, which the OAuth callback URLs are built on. */
  basePath: "" | `/${string}`;
  /** The normalized public origin, absent when OAuth is unavailable. */
  publicUrl?: string | undefined;
  agent: AgentSettings;
  /** The host's `runner` option, or `false` for a process that runs no loop. */
  runner: WfGraphRunnerOptions | false | undefined;
  /** The host's retention windows, from `resolveRetention`. */
  retention: RetentionWindows;
};

export type WfGraphSetup = {
  readonly runtime: WfGraphRuntime;
  readonly extensions: ExtensionSet;
  readonly capabilities: WfGraphRunCapabilities;
  /** The host's in-process Event send, on this setup's runtime. */
  readonly events: WfGraphEvents;
  /**
   * Starts the worker loop in this process on the setup's runtime and wakes,
   * with the settings resolved when the setup opened, or undefined for a
   * setup opened with `runner: false`.
   */
  readonly startRunner: (() => InProcessRunner) | undefined;
  /** Disposes the runtime, then closes the backend. */
  readonly close: () => Promise<void>;
};

/** A runtime over an opened persistence backend, and the close that gives both back. */
export type OpenedRuntime = {
  readonly runtime: WfGraphRuntime;
  /** Settles the wakes, disposes the runtime, then closes the backend. */
  readonly close: () => Promise<void>;
};

/**
 * Builds the runtime over `persistence`, which the caller just opened, and
 * builds the runtime's Layer graph at once, so a graph that cannot build fails
 * here instead of on the first request or pass. A failure gives back the
 * runtime and the backend. `close` first awaits `settleWakes`, such as a Queue
 * wake's sends in flight, then disposes the runtime, then closes the backend,
 * last because a Layer finalizer is free to use persistence while closing.
 */
export async function openWfGraphRuntime(
  input: Omit<WfGraphRuntimeParts, "repositories"> & {
    persistence: WfGraphPersistenceInstance;
    settleWakes?: (() => Promise<void>) | undefined;
  }
): Promise<OpenedRuntime> {
  const { persistence, settleWakes, ...parts } = input;
  let runtime: WfGraphRuntime | undefined;
  const closes = [
    async () => await settleWakes?.(),
    async () => await runtime?.dispose(),
    persistence.close,
  ];
  try {
    runtime = createWfGraphRuntime({
      ...parts,
      repositories: persistence.repositories,
    });
    await runtime.runPromise(Effect.void);
  } catch (error) {
    return await failAfterClose(error, closes);
  }
  return { runtime, close: () => closeInOrder(closes) };
}

export async function openWfGraphSetup(
  options: WfGraphSetupOptions
): Promise<WfGraphSetup> {
  assertValidRunnerOptions(options.runner);
  if (options.logger) {
    configureLoggingWithBridge(options.logger);
  } else {
    warnWhenLoggingUnconfigured();
  }

  const cipher = createIntegrationCipher(options.encryption);
  const extensions = assembleExtensions(options.extensions ?? {}, {
    entityResolverTimeoutMs: options.entityResolverTimeoutMs,
  });

  // A host who forgets to pass its integrations gets an empty editor and no
  // error, so the counts go where a startup log is read.
  const { events, actions, integrations } = extensions.catalog;
  getAppLogger("extensions").info(
    `Extension surface assembled: ${events.length} events, ${actions.length} actions, ${integrations.length} integrations`
  );

  const persistence: WfGraphPersistenceInstance =
    await options.persistence.open(cipher);
  getAppLogger("persistence").info("Persistence configured", {
    persistence: persistence.description,
  });

  const { capabilities } = persistence;
  const wakes = createAppRunWakes(capabilities.broadcast);
  // A process that runs no loop of its own serves the Runs view for loops
  // elsewhere, which this process cannot see, so it assumes their default.
  const pollMs =
    (options.runner === false ? undefined : options.runner?.pollMs) ??
    capabilities.loopDefaults.pollMs;
  const { runtime, close } = await openWfGraphRuntime({
    persistence,
    extensions,
    appContext: {
      publicUrl: options.publicUrl,
      apiBasePath: `${options.basePath}/api`,
      overdueAfterMs: overdueAfterMs(pollMs),
      runRetentionMs: options.retention.runMs,
    },
    agent: options.agent,
    wakes: wakes.sinks,
  });

  try {
    // Resolved before the app starts serving, so a backend that runs no
    // long-lived loop is refused at startup.
    const settings =
      options.runner === false
        ? undefined
        : resolveRunnerSettings(
            capabilities,
            options.runner ?? {},
            options.retention
          );

    return {
      runtime,
      extensions,
      capabilities,
      events: createHostEvents(runtime, extensions),
      startRunner:
        settings === undefined
          ? undefined
          : () =>
              startInProcessRunner({ runtime, extensions, wakes, settings }),
      close,
    };
  } catch (error) {
    return await failAfterClose(error, [close]);
  }
}
