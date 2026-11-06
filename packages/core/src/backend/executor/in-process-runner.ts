/**
 * The worker loop a process runs from start to stop, as a fiber on the app's
 * runtime whose scope also holds the backend's wake listener. A loop that dies
 * restarts after a backoff. `stop` ends the loop, waits for its passes in
 * flight for at most `RUNNER_DRAIN_MS` and then for the listener, and
 * interrupts the fiber when that wait runs `RUNNER_STOP_MARGIN_MS` past the
 * drain. The runtime and the persistence backend must outlive the runner.
 */

import { Cause, Effect, Exit, Fiber, Schedule } from "effect";
import type { ExtensionSet } from "#src/backend/extensions/extension-set";
import { createWorkflowActions } from "#src/backend/extensions/workflow-actions";
import { createWorkflowEntities } from "#src/backend/extensions/workflow-entities";
import {
  DEFAULT_DELIVERY_CONCURRENCY,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_INBOX_RETENTION_MS,
  DEFAULT_LEASE_MS,
  runWorkerLoop,
  type WorkerLoopOutcome,
} from "#src/backend/executor/worker-loop";
import type {
  AppRunWakes,
  WorkerWake,
} from "#src/backend/executor/worker-wake";
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
   * How many runs the loop advances at once. Defaults to 1 on SQLite, which
   * allows one writer, and to 10 on PostgreSQL, or to the pool's
   * `maxConnections` when that is lower.
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
};

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
 * Refuses an `events.retentionMs` the sweep could not use, so the mistake
 * fails at startup. `option` names the function the host called.
 */
export function assertValidRetention(
  retentionMs: number | undefined,
  option: string
): void {
  if (
    retentionMs !== undefined &&
    (!Number.isInteger(retentionMs) || retentionMs <= 0)
  ) {
    throw new Error(
      `${option}'s events.retentionMs must be a positive integer of milliseconds. Leave it out to keep settled inbox rows for seven days.`
    );
  }
}

/** The settings a loop runs with, the host's options over the backend's. */
export type RunnerSettings = {
  concurrency: number;
  deliveryConcurrency: number;
  pollMs: number;
  leaseMs: number | undefined;
  heartbeatMs: number | undefined;
  retentionMs: number;
};

/**
 * Resolves the loop's settings once, and refuses a backend that runs no
 * long-lived loop, so the mistake fails before the app starts serving.
 */
export function resolveRunnerSettings(
  capabilities: WfGraphRunCapabilities,
  options: WfGraphRunnerOptions,
  retentionMs: number | undefined
): RunnerSettings {
  const { loopDefaults, connectionLimit } = capabilities;
  const pollMs = options.pollMs ?? loopDefaults.pollMs;
  if (pollMs === undefined) {
    throw new Error(
      "This persistence backend runs no long-lived worker loop; its runs advance through the tick driver"
    );
  }
  return {
    concurrency:
      options.concurrency ??
      Math.min(loopDefaults.concurrency, connectionLimit),
    deliveryConcurrency:
      options.deliveryConcurrency ?? DEFAULT_DELIVERY_CONCURRENCY,
    pollMs,
    leaseMs: options.leaseMs,
    heartbeatMs: options.heartbeatMs,
    retentionMs: retentionMs ?? DEFAULT_INBOX_RETENTION_MS,
  };
}

export type InProcessRunner = {
  /**
   * Ends the loop, waits for its drain and for its listener to stop, and
   * writes one record saying how the loop's passes in flight ended.
   */
  readonly stop: () => Promise<void>;
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

  // Built per start, so a loop that restarts begins with none of the state the
  // one that died held.
  const loop = Effect.suspend(() =>
    runWorkerLoop({
      // Built per pass, so a decrypted credential lives as long as its pass.
      actions: () => createWorkflowActions(extensions, runtime),
      entities: createWorkflowEntities(extensions),
      delivery: { events: extensions.events, runtime },
      signal,
      drainMs: RUNNER_DRAIN_MS,
      wake: wakes.local,
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

  // The runtime builds the Layer graph before the program's first step, so a
  // fiber that failed without taking that step failed building the graph.
  let started = false;
  const program = Effect.scoped(
    Effect.gen(function* () {
      started = true;
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
  const ended = Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    if (
      !started &&
      Exit.isFailure(exit) &&
      !Cause.hasInterruptsOnly(exit.cause)
    ) {
      logger.error(
        "Could not build the Layer graph the worker loop runs on; this process advances no runs",
        { error: Cause.squash(exit.cause) }
      );
    }
    return exit;
  });
  logger.info("Worker loop started", {
    runner: {
      concurrency: settings.concurrency,
      deliveryConcurrency: settings.deliveryConcurrency,
      pollMs: settings.pollMs,
      retentionMs: settings.retentionMs,
      broadcast: wakes.broadcast !== undefined,
    },
  });

  return {
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
