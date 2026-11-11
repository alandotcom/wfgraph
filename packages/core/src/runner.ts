import type { WfGraphAppOptions } from "#src/app";
import type { InProcessRunner } from "#src/backend/executor/in-process-runner";
import { failAfterClose } from "#src/backend/lib/close-in-order";
import type { WfGraphAuth } from "#src/backend/lib/http/authorize";
import { normalizeBasePath } from "#src/backend/lib/http/mount-path";
import { resolvePublicUrl } from "#src/backend/lib/http/public-url";
import { assertValidEncryptionKey } from "#src/backend/services/integrations/cipher";
import type { WfGraphEvents } from "#src/backend/host-events";
import { resolveRetention } from "#src/backend/host-retention";
import { openWfGraphSetup } from "#src/backend/setup";

/**
 * The options `createWfGraphApp` takes, so a host builds one object in a
 * shared module and hands it to both processes: the app with
 * `{ ...options, runner: false }`, and the runner as it is.
 *
 * The runner serves no HTTP, so it ignores `auth`, `client`, `mcp`, `agent`
 * and `events.key`, and `auth` is optional here. `runner: false` says that the
 * app runs no loop, so the runner ignores it and runs its loop with the
 * defaults; a `runner` object tunes the runner's loop. Everything else means
 * what it means on the app, and `persistence`, `encryption`, `extensions`,
 * `basePath`, `publicUrl`, `entityResolverTimeoutMs`, `events.retentionMs`
 * and `runs.retentionMs` must match the app's.
 */
export type CreateWfGraphRunnerOptions = Omit<WfGraphAppOptions, "auth"> & {
  auth?: WfGraphAuth | undefined;
};

export type WfGraphRunner = {
  /** Raises an Event into the event inbox, as `app.events` does. */
  events: WfGraphEvents;
  /**
   * Stops the loop, waiting up to ten seconds for the runs it is advancing,
   * then disposes the runtime and closes the database.
   */
  dispose: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

/**
 * Runs the worker loop that advances workflow runs, in a process that serves
 * no HTTP: the dedicated worker beside apps created with `runner: false`, on
 * the same options object. Refuses a backend whose database no other process
 * can share, such as SQLite, and one that runs no long-lived loop, such as
 * Hyperdrive.
 */
export async function createWfGraphRunner(
  options: CreateWfGraphRunnerOptions
): Promise<WfGraphRunner> {
  const basePath = normalizeBasePath(options.basePath ?? "/");
  const publicUrl = resolvePublicUrl(options.publicUrl);
  assertValidEncryptionKey(options.encryption.key, "createWfGraphRunner");
  const retention = resolveRetention({
    events: options.events,
    runs: options.runs,
    caller: "createWfGraphRunner",
  });

  const setup = await openWfGraphSetup({
    logger: options.logger,
    persistence: options.persistence,
    encryption: options.encryption,
    extensions: options.extensions,
    entityResolverTimeoutMs: options.entityResolverTimeoutMs,
    basePath,
    publicUrl,
    agent: { enabled: false },
    // `false` is the app's own setting; this process always runs a loop.
    runner: options.runner === false ? undefined : options.runner,
    retention,
  });

  let runner: InProcessRunner;
  try {
    if (setup.capabilities.processes === "one") {
      throw new Error(
        "createWfGraphRunner cannot run on this persistence backend: no other process can share its database, so its runs advance in the app's own process"
      );
    }
    // A setup opened with a `runner` option other than `false` has a loop.
    if (setup.startRunner === undefined) {
      throw new Error("createWfGraphRunner's setup resolved no worker loop");
    }
    runner = setup.startRunner();
  } catch (error) {
    return await failAfterClose(error, [setup.close]);
  }

  const disposeOnce = async (): Promise<void> => {
    await runner.stop();
    await setup.close();
  };
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => (disposal ??= disposeOnce());
  return { events: setup.events, dispose, [Symbol.asyncDispose]: dispose };
}
