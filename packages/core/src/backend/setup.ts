/**
 * What `createWfGraphApp` and `createWfGraphRunner` both stand on: the worker
 * loop's settings, logging, the cipher, the extension surface, the opened
 * persistence backend, the app's run wakes, the runtime whose
 * `ExecutionDriver` announces to them, and the host's Event send over that
 * runtime. The loop's options are refused before anything opens. A failure
 * while opening gives back whatever was acquired. `close` disposes the
 * runtime and then closes the backend, so the runner must stop first.
 */

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
} from "#src/backend/runtime";
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
  /** The function the host called, which a refused option's message names. */
  caller: string;
  /** The host's `runner` option, or `false` for a process that runs no loop. */
  runner: WfGraphRunnerOptions | false | undefined;
  /** The host's `events.retentionMs`. */
  retentionMs: number | undefined;
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

export async function openWfGraphSetup(
  options: WfGraphSetupOptions
): Promise<WfGraphSetup> {
  assertValidRunnerOptions(options);
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

  try {
    const { capabilities } = persistence;
    const wakes = createAppRunWakes(capabilities.broadcast);

    // Built on the first Effect it runs, so opening the setup opens nothing
    // more than the backend did.
    const runtime = createWfGraphRuntime({
      extensions,
      appContext: {
        publicUrl: options.publicUrl,
        apiBasePath: `${options.basePath}/api`,
      },
      agent: options.agent,
      repositories: persistence.repositories,
      wakes: wakes.sinks,
    });

    // Resolved now, so a backend that runs no long-lived loop is refused
    // before the app starts serving.
    const settings =
      options.runner === false
        ? undefined
        : resolveRunnerSettings(
            capabilities,
            options.runner ?? {},
            options.retentionMs
          );

    return {
      runtime,
      extensions,
      capabilities,
      events: createHostEvents(runtime),
      startRunner:
        settings === undefined
          ? undefined
          : () =>
              startInProcessRunner({ runtime, extensions, wakes, settings }),
      close: () =>
        closeInOrder([
          () => runtime.dispose(),
          // Last, because a Layer finalizer is free to use persistence while
          // closing.
          persistence.close,
        ]),
    };
  } catch (error) {
    return await failAfterClose(error, [persistence.close]);
  }
}
