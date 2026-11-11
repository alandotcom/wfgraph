/**
 * The worker loop a process runs from start to stop, as a fiber on the app's
 * runtime whose scope also holds the backend's wake listener. A loop that dies
 * restarts after a backoff. `stop` ends the loop, waits for its passes in
 * flight for at most `RUNNER_DRAIN_MS` and then for the listener, and
 * interrupts the fiber when that wait runs `RUNNER_STOP_MARGIN_MS` past the
 * drain. The runtime must have built its Layer graph already, as
 * `openWfGraphRuntime` does, and it and the persistence backend must outlive
 * the runner.
 */

import { Cause, Effect, Exit, Fiber, Schedule } from "effect";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { createWorkflowEntities } from "#src/backend/extensions/workflow-entities";
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_MS,
  type LaneConcurrency,
  runWorkerLoop,
  type WorkerLoopOutcome,
} from "#src/backend/executor/worker-loop";
import type {
  AppRunWakes,
  WorkerWake,
} from "#src/backend/executor/worker-wake";
import type { RetentionWindows } from "#src/backend/host-retention";
import { getAppLogger } from "#src/backend/lib/logger";
import type {
  RunWakeBroadcast,
  WfGraphRunCapabilities,
} from "#src/backend/persistence/types";
import type { WfGraphRuntime } from "#src/backend/runtime";

/**
 * Tunes the worker loop a process runs. Every field is optional, and each one
 * left out takes the persistence backend's default.
 */
export type WfGraphRunnerOptions = {
  /**
   * How many runs the loop advances at once. Defaults to half the backend's
   * connections, rounded down and at least 1, capped at the backend's own
   * default: `min(10, max(1, floor(maxConnections / 2)))` on PostgreSQL, which
   * is 5 for the default pool of 10, and 1 on SQLite, which allows one writer.
   * The other half serves the delivery and cron lanes and the HTTP requests
   * that share the pool. A value set here is used as it is.
   */
  concurrency?: number | undefined;
  /**
   * How many Event deliveries the loop runs at once, in slots of their own
   * beside the runs', so a run holding every run slot never delays an Event's
   * delivery. Defaults to 1 on every backend.
   */
  deliveryConcurrency?: number | undefined;
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
  /**
   * The largest value one durable step may answer, in bytes of its JSON, which
   * the run's step memo stores and every later pass of the run reads back. A
   * step answering more fails its node at once, without retries, with a
   * message naming the step and the size. Defaults to 1,048,576 (1 MiB), the
   * size of the largest request body the app accepts, which holds an ordinary
   * API response.
   */
  maxStepValueBytes?: number | undefined;
};

/** How many deliveries a loop or a tick runs at once when the host sets none. */
const DEFAULT_DELIVERY_CONCURRENCY = 1;

/**
 * How many cron fires a loop or a tick runs at once. One slot is enough: a
 * fire is one preflight and one short transaction, and a timer that falls due
 * while the slot is busy fires on the next claim, for its latest slot.
 */
const CRON_CONCURRENCY = 1;

/** How long `stop` waits for passes in flight before it interrupts them. */
const RUNNER_DRAIN_MS = 10_000;

/**
 * How much longer than the drain `stop` waits for the loop's fiber, which
 * covers stopping the listener, before it interrupts the fiber. Also the most
 * `stop` waits for the listener to stop, or for an interrupted fiber to end.
 */
const RUNNER_STOP_MARGIN_MS = 5_000;

/**
 * How long a loop that died waits before it starts again: 200 ms, doubling
 * per consecutive death, at most 5 s, so a restart never outlasts the margin
 * `stop` allows.
 */
const RESTART_BACKOFF = Schedule.min([
  Schedule.exponential("200 millis"),
  Schedule.spaced("5 seconds"),
]);

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
    "deliveryConcurrency",
    "pollMs",
    "leaseMs",
    "heartbeatMs",
    "maxStepValueBytes",
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

/**
 * The run slots a loop takes when the host sets none: half the backend's
 * connections, at least one, and at most the backend's own default. Every
 * pass holds a connection while it writes, so a loop taking the whole pool
 * would leave the delivery and cron lanes and the app's HTTP requests queued
 * behind its runs.
 */
function defaultRunConcurrency(capabilities: WfGraphRunCapabilities): number {
  const { loopDefaults, connectionLimit } = capabilities;
  return Math.min(
    loopDefaults.concurrency,
    Math.max(1, Math.floor(connectionLimit / 2))
  );
}

/**
 * Each lane's slots, the host's options over the backend's defaults: the
 * runs' from `concurrency`, the deliveries' from `deliveryConcurrency`, and
 * the cron fires' fixed at `CRON_CONCURRENCY`.
 */
function resolveLaneConcurrency(
  capabilities: WfGraphRunCapabilities,
  options: Pick<WfGraphRunnerOptions, "concurrency" | "deliveryConcurrency">
): LaneConcurrency {
  return {
    run: options.concurrency ?? defaultRunConcurrency(capabilities),
    delivery: options.deliveryConcurrency ?? DEFAULT_DELIVERY_CONCURRENCY,
    cron: CRON_CONCURRENCY,
  };
}

/** The settings a tick runs with, which a host does not tune. */
export type TickSettings = {
  concurrency: LaneConcurrency;
  retention: RetentionWindows;
};

/** Resolves a tick's settings from the backend's defaults and the host's retention windows. */
export function resolveTickSettings(
  capabilities: WfGraphRunCapabilities,
  retention: RetentionWindows
): TickSettings {
  return {
    concurrency: resolveLaneConcurrency(capabilities, {}),
    retention,
  };
}

/** The settings a loop runs with, the host's options over the backend's. */
export type RunnerSettings = {
  concurrency: LaneConcurrency;
  pollMs: number;
  leaseMs: number | undefined;
  heartbeatMs: number | undefined;
  maxStepValueBytes: number | undefined;
  retention: RetentionWindows;
};

/**
 * Resolves the loop's settings once, and refuses a backend that runs no
 * long-lived loop, so the mistake fails before the app starts serving.
 */
export function resolveRunnerSettings(
  capabilities: WfGraphRunCapabilities,
  options: WfGraphRunnerOptions,
  retention: RetentionWindows
): RunnerSettings {
  const pollMs = options.pollMs ?? capabilities.loopDefaults.pollMs;
  if (pollMs === undefined) {
    throw new Error(
      "This persistence backend runs no long-lived worker loop; its runs advance through the ticks that wfWorker's scheduled and queue handlers run"
    );
  }
  return {
    concurrency: resolveLaneConcurrency(capabilities, options),
    pollMs,
    leaseMs: options.leaseMs,
    heartbeatMs: options.heartbeatMs,
    maxStepValueBytes: options.maxStepValueBytes,
    retention,
  };
}

export type InProcessRunner = {
  /**
   * Ends the loop, waits for its drain and for its listener to stop, and
   * writes one record saying how the loop's passes in flight ended.
   */
  readonly stop: () => Promise<void>;
  /**
   * When the loop last finished a turn of polling and claiming, or undefined
   * before its first. A loop that died and is waiting out its restart
   * backoff, or that waits on a claim the database never answers, falls
   * behind its poll interval here.
   */
  readonly lastTurnAt: () => Date | undefined;
  /** When the loop started, which stands in for its last turn before the first. */
  readonly startedAt: Date;
  /** How long the loop sleeps between turns when nothing wakes it. */
  readonly pollMs: number;
};

export function startInProcessRunner(input: {
  runtime: WfGraphRuntime;
  extensions: ExtensionSet;
  /** The app's wakes: the loop subscribes to `local`, and listens to `broadcast`. */
  wakes: AppRunWakes;
  settings: RunnerSettings;
}): InProcessRunner {
  const { runtime, extensions, wakes, settings } = input;
  const controller = new AbortController();
  const { signal } = controller;
  let lastTurnAt: Date | undefined;
  const startedAt = new Date();

  // Built per start, so a loop that restarts begins with none of the state the
  // one that died held.
  const loop = Effect.suspend(() =>
    runWorkerLoop({
      // Built per pass, so a decrypted credential lives as long as its pass.
      actions: () => createWorkflowActions(extensions, runtime),
      entities: createWorkflowEntities(extensions),
      signal,
      drainMs: RUNNER_DRAIN_MS,
      wake: wakes.local,
      onTurn: () => {
        lastTurnAt = new Date();
      },
      ...settings,
    })
  );

  const supervised = loop.pipe(
    Effect.sandbox,
    Effect.tapError((cause) =>
      Effect.sync(() => {
        logger.error("The worker loop died; it restarts after a backoff", {
          error: Cause.squash(cause),
        });
      })
    ),
    Effect.retry({ schedule: RESTART_BACKOFF, while: () => !signal.aborted }),
    // Reached only when the loop died after `stop` was called, so there is no
    // drain to report.
    Effect.orElseSucceed((): WorkerLoopOutcome => ({
      drained: 0,
      interrupted: 0,
    }))
  );

  const program = Effect.scoped(
    Effect.gen(function* () {
      if (wakes.broadcast !== undefined) {
        // Forked, so a database that is down at boot delays no claim. A
        // listener that never starts costs a wake from another process at most
        // one poll.
        yield* Effect.forkScoped(listen(wakes.broadcast, wakes.local));
      }
      return yield* supervised;
    })
  );

  const fiber = runtime.runFork(program);
  const ended = Effect.runPromise(Fiber.await(fiber));
  logger.info("Worker loop started", {
    runner: {
      concurrency: settings.concurrency.run,
      deliveryConcurrency: settings.concurrency.delivery,
      pollMs: settings.pollMs,
      inboxRetentionMs: settings.retention.inboxMs,
      // Null when no run window is set, so the record says retention is off.
      runRetentionMs: settings.retention.runMs ?? null,
      broadcast: wakes.broadcast !== undefined,
    },
  });

  return {
    lastTurnAt: () => lastTurnAt,
    startedAt,
    pollMs: settings.pollMs,
    stop: async () => {
      controller.abort();
      const exit = await within(ended, RUNNER_DRAIN_MS + RUNNER_STOP_MARGIN_MS);
      if (exit === undefined) {
        await within(
          Effect.runPromise(Fiber.interrupt(fiber)),
          RUNNER_STOP_MARGIN_MS
        );
        logger.warn(
          "Worker loop stopped; it outlasted its drain and was interrupted",
          {
            runner: { waitedMs: RUNNER_DRAIN_MS + RUNNER_STOP_MARGIN_MS },
          }
        );
        return;
      }
      if (Exit.isSuccess(exit)) {
        logger.info("Worker loop stopped", { runner: exit.value });
      }
    },
  };
}

/** Logs a listener that could not be stopped; the pool's close ends it. */
function stopFailed(error: unknown) {
  return Effect.sync(() => {
    logger.warn("Could not stop listening for other processes' wakes", {
      error,
    });
  });
}

/**
 * Listens for the runs other processes make due, for as long as the scope it
 * runs in is open. Connecting is interruptible, and a listener that starts
 * after it was abandoned is stopped at once; stopping the listener is bounded,
 * since a database that went away may never answer. A failure to listen is
 * logged, and the poll finds the runs a wake would have.
 */
function listen(broadcast: RunWakeBroadcast, local: WorkerWake) {
  type Listening = Awaited<ReturnType<RunWakeBroadcast["listen"]>>;
  const connect = Effect.callback<Listening, unknown>((resume) => {
    let abandoned = false;
    broadcast
      .listen(() => local.announce())
      .then(
        (listening) => {
          if (abandoned) {
            listening.stop().catch(() => undefined);
            return;
          }
          resume(Effect.succeed(listening));
        },
        (error: unknown) => resume(Effect.fail(error))
      );
    return Effect.sync(() => {
      abandoned = true;
    });
  });
  const stop = (listening: Listening) =>
    Effect.tryPromise(() => listening.stop()).pipe(
      Effect.catch(stopFailed),
      Effect.timeoutOrElse({
        duration: RUNNER_STOP_MARGIN_MS,
        orElse: () =>
          stopFailed(`no answer within ${RUNNER_STOP_MARGIN_MS} ms`),
      })
    );
  return Effect.acquireRelease(connect, stop, { interruptible: true }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn(
          "Could not listen for runs other processes make due; the poll finds them",
          { error }
        );
      })
    )
  );
}

/** Answers what `promise` settles with, or undefined once `ms` has passed. */
async function within<A>(
  promise: Promise<A>,
  ms: number
): Promise<A | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
