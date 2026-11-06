/**
 * The wakes one app's producers and its worker loop share. A producer calls
 * `announce()` on every sink after committing a write that makes a run due,
 * such as a `resolvePark`. The in-process wake makes the loop claim at once,
 * without waiting for its next poll; a wake that lands while the loop is
 * claiming makes it claim once more right after.
 */

import type { RunWakeBroadcast } from "#src/backend/persistence/types";
import type { RunWakeSink } from "#src/backend/services/executions/wakes";

/** Wakes the worker loops in this process that subscribed to it. */
export type WorkerWake = RunWakeSink & {
  /** Calls `listener` on every wake until the returned function is called. */
  subscribe: (listener: () => void) => () => void;
};

export function createWorkerWake(): WorkerWake {
  const listeners = new Set<() => void>();
  return {
    announce: () => {
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * One app's wakes: the loop in this process, and the backend's broadcast to
 * and from loops in other processes when the backend has one.
 */
export type AppRunWakes = {
  readonly local: WorkerWake;
  readonly broadcast: RunWakeBroadcast | undefined;
  /** Every sink a producer announces to: `local`, then `broadcast`. */
  readonly sinks: readonly RunWakeSink[];
};

export function createAppRunWakes(
  broadcast: RunWakeBroadcast | undefined
): AppRunWakes {
  const local = createWorkerWake();
  return {
    local,
    broadcast,
    sinks: broadcast === undefined ? [local] : [local, broadcast],
  };
}
