/**
 * What `createWfGraphApp` and `createWfGraphRunner` both stand on: logging,
 * the cipher, the extension surface, the opened persistence backend, the
 * app's run wakes, and the runtime whose `ExecutionDriver` announces to them.
 * A failure while opening gives back whatever was acquired. `close` disposes
 * the runtime and then closes the backend, so the runner must stop first.
 */

import type { Inngest } from "inngest";
import type { AgentSettings } from "#src/backend/agent/config";
import {
  assembleExtensions,
  type ExtensionSet,
  type WfGraphExtensions,
} from "#src/backend/extensions/extension-set";
import {
  type InProcessRunner,
  resolveRunnerSettings,
  startInProcessRunner,
  type WfGraphRunnerOptions,
} from "#src/backend/executor/in-process-runner";
import { createAppRunWakes } from "#src/backend/executor/worker-wake";
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
  /** The client Events are forwarded on, for the app that serves webhooks. */
  inngest?: Inngest | undefined;
};

export type WfGraphSetup = {
  readonly runtime: WfGraphRuntime;
  readonly extensions: ExtensionSet;
  readonly capabilities: WfGraphRunCapabilities;
  /**
   * Resolves the worker loop's settings, throwing for a backend that runs no
   * long-lived loop, and answers how to start that loop in this process on
   * the setup's runtime and wakes.
   */
  readonly prepareRunner: (
    options: WfGraphRunnerOptions
  ) => () => InProcessRunner;
  /** Disposes the runtime, then closes the backend. */
  readonly close: () => Promise<void>;
};

export async function openWfGraphSetup(
  options: WfGraphSetupOptions
): Promise<WfGraphSetup> {
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
      inngest: options.inngest,
      extensions,
      appContext: {
        publicUrl: options.publicUrl,
        apiBasePath: `${options.basePath}/api`,
      },
      agent: options.agent,
      repositories: persistence.repositories,
      wakes: wakes.sinks,
    });

    return {
      runtime,
      extensions,
      capabilities,
      prepareRunner: (runner) => {
        const settings = resolveRunnerSettings(capabilities, runner);
        return () =>
          startInProcessRunner({ runtime, extensions, wakes, settings });
      },
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
