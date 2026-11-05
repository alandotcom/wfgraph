/**
 * Makes the worker loops it is handed to claim at once. A producer in the same
 * process calls `wake()` after committing a write that makes a run due, such as
 * a `resolvePark`, so the loop acts on it without waiting for its next poll. A
 * wake that lands while a loop is claiming makes it claim once more right after.
 */
export type WorkerWake = {
  wake: () => void;
  /** Calls `listener` on every wake until the returned function is called. */
  subscribe: (listener: () => void) => () => void;
};

export function createWorkerWake(): WorkerWake {
  const listeners = new Set<() => void>();
  return {
    wake: () => {
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
