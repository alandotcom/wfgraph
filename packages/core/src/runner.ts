import {
  assertValidRunnerOptions,
  type InProcessRunner,
  type WfGraphRunnerOptions,
} from "#src/backend/executor/in-process-runner";
import type { WfGraphExtensions } from "#src/backend/extensions/extension-set";
import { failAfterClose } from "#src/backend/lib/close-in-order";
import { normalizeBasePath } from "#src/backend/lib/http/mount-path";
import { resolvePublicUrl } from "#src/backend/lib/http/public-url";
import type { WfGraphPersistence } from "#src/backend/persistence/types";
import {
  assertValidEncryptionKey,
  type EncryptionRuntimeConfig,
} from "#src/backend/services/integrations/cipher";
import { openWfGraphSetup } from "#src/backend/setup";
import type { WfGraphLogger } from "@wfgraph/shared/types/logger";

export type CreateWfGraphRunnerOptions = {
  /** The same database the app names, with its `runner: false`. */
  persistence: WfGraphPersistence;
  /** The app's key, which decrypts the credentials a step reads. */
  encryption: EncryptionRuntimeConfig;
  /** The app's extension surface: the actions and Entities its runs reach. */
  extensions?: WfGraphExtensions | undefined;
  /**
   * The app's `basePath` and `publicUrl`. A step that refreshes an OAuth
   * token registers the same callback URLs the app serves, built from these.
   */
  basePath?: string | undefined;
  publicUrl?: string | undefined;
  /** Maximum time in milliseconds for one call to an Entity resolver. */
  entityResolverTimeoutMs?: number | undefined;
  /** Where log lines go, as on `createWfGraphApp`. */
  logger?: WfGraphLogger | undefined;
  /** Tunes the loop, as `createWfGraphApp`'s `runner` option does. */
  runner?: WfGraphRunnerOptions | undefined;
};

export type WfGraphRunner = {
  /**
   * Stops the loop, waiting up to ten seconds for the runs it is advancing,
   * then disposes the runtime and closes the database.
   */
  dispose: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

/**
 * Runs the worker loop that advances workflow runs, in a process that serves
 * no HTTP: the dedicated worker beside apps created with `runner: false`.
 * Refuses a backend whose database no other process can share, such as
 * SQLite, and one that runs no long-lived loop, such as Hyperdrive.
 */
export async function createWfGraphRunner(
  options: CreateWfGraphRunnerOptions
): Promise<WfGraphRunner> {
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const publicUrl = resolvePublicUrl(options.publicUrl);
  assertValidEncryptionKey(options.encryption.key);
  assertValidRunnerOptions(options.runner);

  const setup = await openWfGraphSetup({
    logger: options.logger,
    persistence: options.persistence,
    encryption: options.encryption,
    extensions: options.extensions,
    entityResolverTimeoutMs: options.entityResolverTimeoutMs,
    basePath,
    publicUrl,
    agent: { enabled: false },
  });

  let runner: InProcessRunner;
  try {
    if (setup.capabilities.processes === "one") {
      throw new Error(
        "createWfGraphRunner cannot run on this persistence backend: no other process can share its database, so its runs advance in the app's own process"
      );
    }
    runner = setup.prepareRunner(options.runner ?? {})();
  } catch (error) {
    return await failAfterClose(error, [setup.close]);
  }

  const disposeOnce = async (): Promise<void> => {
    await runner.stop();
    await setup.close();
  };
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => (disposal ??= disposeOnce());
  return { dispose, [Symbol.asyncDispose]: dispose };
}
