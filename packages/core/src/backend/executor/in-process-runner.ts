/**
 * The worker loop `createWfGraphApp` runs in its own process, from start to
 * stop. `stop` ends the loop and waits for its passes in flight for at most
 * `RUNNER_DRAIN_MS`, then stops listening for other processes' wakes; the
 * runtime and the persistence backend must outlive it. The loop's defaults
 * come from the backend, so the app never names one.
 */

import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { createWorkflowEntities } from "#src/backend/extensions/workflow-entities";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  runWorkerLoop,
} from "#src/backend/executor/worker-loop";
import type { WorkerWake } from "#src/backend/executor/worker-wake";
import { getAppLogger } from "#src/backend/lib/logger";
import type { WfGraphPersistenceInstance } from "#src/backend/persistence/types";
import type { WfGraphRuntime } from "#src/backend/runtime";

/**
 * Tunes the worker loop an app runs in its own process. Every field is
 * optional, and each one left out takes the persistence backend's default.
 */
export type WfGraphRunnerOptions = {
  /**
   * How many runs the loop advances at once. Defaults to 1 on SQLite, which
   * allows one writer, and to 10 on PostgreSQL.
   */
  concurrency?: number | undefined;
  /**
   * How long the loop sleeps between looking for due runs when nothing wakes
   * it, in milliseconds. Defaults to 250 on SQLite and 1,000 on PostgreSQL.
   */
  pollMs?: number | undefined;
  /**
   * How long the loop holds a run it is advancing before another loop may
   * take it over, in milliseconds. Defaults to 60,000.
   */
  leaseMs?: number | undefined;
  /**
   * How often the loop renews that hold while a step runs, in milliseconds.
   * Defaults to 20,000, and must be shorter than `leaseMs`, defaulted or not.
   */
  heartbeatMs?: number | undefined;
};

/** How long `stop` waits for passes in flight before it interrupts them. */
const RUNNER_DRAIN_MS = 10_000;

const logger = getAppLogger("executor");

/**
 * Refuses a `runner` option a loop could not run with, so the mistake fails
 * at startup.
 */
export function assertValidRunnerOptions(
  options: false | WfGraphRunnerOptions | undefined
): void {
  if (options === false || options === undefined) return;
  for (const key of [
    "concurrency",
    "pollMs",
    "leaseMs",
    "heartbeatMs",
  ] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`runner.${key} must be a positive integer`);
    }
  }
  // A pass whose lease ran out before its next renewal loses its run.
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (heartbeatMs >= leaseMs) {
    throw new Error(
      `runner.heartbeatMs (${heartbeatMs}) must be shorter than runner.leaseMs (${leaseMs})`
    );
  }
}

export type InProcessRunner = {
  /** Ends the loop, waits for its drain, and stops its wake listener. */
  readonly stop: () => Promise<void>;
};

export function startInProcessRunner(input: {
  runtime: WfGraphRuntime;
  extensions: ExtensionSet;
  persistence: WfGraphPersistenceInstance;
  /** The wake the app's `ExecutionDriver` calls after each write. */
  wake: WorkerWake;
  options: WfGraphRunnerOptions;
}): InProcessRunner {
  const { runtime, extensions, persistence, wake, options } = input;
  const { wakes } = persistence;
  const concurrency = options.concurrency ?? persistence.workerConcurrency;
  const pollMs = options.pollMs ?? wakes.pollMs;

  // Startup does not wait for the listener, because a database that is down
  // at boot must not stop the app from serving. A listener that never starts
  // costs a wake from another process at most one poll.
  const listening =
    wakes.kind === "notify"
      ? wakes.broadcast
          .listen(() => wake.wake())
          .catch((error: unknown) => {
            logger.warn(
              "Could not listen for runs other processes make due; the poll finds them",
              { error }
            );
            return undefined;
          })
      : Promise.resolve(undefined);

  const controller = new AbortController();
  const loop = runtime
    .runPromise(
      runWorkerLoop({
        // Built per pass, so a decrypted credential lives as long as its pass.
        actions: () => createWorkflowActions(extensions, runtime),
        entities: createWorkflowEntities(extensions),
        signal: controller.signal,
        drainMs: RUNNER_DRAIN_MS,
        pollMs,
        wake,
        concurrency,
        leaseMs: options.leaseMs,
        heartbeatMs: options.heartbeatMs,
      })
    )
    .catch((error: unknown) => {
      logger.error("The worker loop stopped on a defect", { error });
    });
  logger.info("Worker loop started", {
    runner: { concurrency, pollMs, wakes: wakes.kind },
  });

  return {
    stop: async () => {
      controller.abort();
      await loop;
      const listener = await listening;
      try {
        await listener?.stop();
      } catch (error) {
        logger.warn("Could not stop listening for other processes' wakes", {
          error,
        });
      }
    },
  };
}
