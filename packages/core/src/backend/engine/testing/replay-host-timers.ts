/**
 * Immediate host-timer queue the replay driver owns for one `driveWithReplay`.
 *
 * A pass ends when every branch is parked on a step port, and "parked" is the
 * absence of work the driver can still run. Host macrotasks between two step
 * calls look like that absence unless they land here, so the driver patches
 * `setImmediate` and zero-delay `setTimeout` for the drive and drains this
 * queue instead of counting quiet macrotask turns.
 *
 * Only those two entry points are owned. `setTimeout` with a positive delay,
 * `setInterval`, and `process.nextTick` are intentionally not: a body that
 * awaits one between step ports ends the pass early the same way quiet turns
 * did. Positive `setTimeout` throws so that case fails loudly instead of
 * skewing the Inngest virtual clock the driver keeps for sleeps and waits.
 */

type HostTimers = {
  setImmediate: typeof globalThis.setImmediate;
  clearImmediate: typeof globalThis.clearImmediate;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
};

/** True while one `ReplayHostTimers.install` owns the host timers. */
let installed = false;

export class ReplayHostTimers {
  private nextId = 1;
  private readonly queue = new Map<number, () => void>();
  private host: HostTimers | null = null;
  private suspendDepth = 0;

  /** True when at least one immediate is waiting to run. */
  hasPending(): boolean {
    return this.queue.size > 0;
  }

  /**
   * Runs every queued immediate, flushing microtasks between batches so a
   * resolved promise can enqueue the next timer before the drain decides it
   * is idle.
   */
  async drainUntilIdle(): Promise<void> {
    for (;;) {
      while (this.queue.size > 0) {
        this.runNext();
      }
      // eslint-disable-next-line eslint/no-await-in-loop -- microtasks scheduled by the last batch must land before the next pending check
      await Promise.resolve();
      if (this.queue.size === 0) {
        return;
      }
    }
  }

  /**
   * Patches host timers so they enqueue here. Refuses a second install in the
   * same process while one drive is already owning the globals.
   */
  install(): void {
    if (installed) {
      throw new Error(
        "ReplayHostTimers is already installed. driveWithReplay cannot nest."
      );
    }
    this.host = {
      setImmediate: globalThis.setImmediate,
      clearImmediate: globalThis.clearImmediate,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    };
    installed = true;
    this.patchGlobals();
  }

  /** Restores the host timers saved by `install`. */
  uninstall(): void {
    if (!installed || !this.host) {
      throw new Error(
        "ReplayHostTimers.uninstall called without a matching install."
      );
    }
    this.restoreGlobals();
    this.host = null;
    installed = false;
    this.queue.clear();
    this.suspendDepth = 0;
  }

  /**
   * Restores host timers for work that must use the real clock (step callbacks
   * in the replay half), then re-patches when the outermost callback returns.
   * Nested calls use a depth count so an inner finally cannot re-patch while
   * an outer still expects host timers.
   */
  async withHostTimers<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.host) {
      return await fn();
    }
    this.suspend();
    try {
      return await fn();
    } finally {
      this.resume();
    }
  }

  private suspend(): void {
    if (!this.host) {
      return;
    }
    if (this.suspendDepth === 0) {
      this.restoreGlobals();
    }
    this.suspendDepth += 1;
  }

  private resume(): void {
    if (!this.host || this.suspendDepth === 0) {
      return;
    }
    this.suspendDepth -= 1;
    if (this.suspendDepth === 0) {
      this.patchGlobals();
    }
  }

  private patchGlobals(): void {
    // Host timer types carry Node promisify brands; the queue returns plain ids.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- see above
    globalThis.setImmediate = ((
      fn: (...args: unknown[]) => void,
      ...args: unknown[]
    ) => this.enqueue(() => fn(...args))) as unknown as typeof setImmediate;

    globalThis.clearImmediate = (id: unknown) => {
      this.cancel(id);
    };

    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- see above
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const delay = Math.max(0, ms ?? 0);
      if (delay > 0) {
        throw new Error(
          "ReplayHostTimers does not own delayed setTimeout. A positive delay between step ports ends a pass early; keep delayed work inside step.run or use runtime.sleep."
        );
      }
      return this.enqueue(() => fn(...args));
    }) as unknown as typeof setTimeout;

    globalThis.clearTimeout = (id: unknown) => {
      this.cancel(id);
    };
  }

  private restoreGlobals(): void {
    if (!this.host) {
      return;
    }
    globalThis.setImmediate = this.host.setImmediate;
    globalThis.clearImmediate = this.host.clearImmediate;
    globalThis.setTimeout = this.host.setTimeout;
    globalThis.clearTimeout = this.host.clearTimeout;
  }

  private enqueue(fn: () => void): number {
    const id = this.nextId++;
    this.queue.set(id, fn);
    return id;
  }

  private cancel(id: unknown): void {
    if (typeof id === "number") {
      this.queue.delete(id);
    }
  }

  private runNext(): void {
    const next = this.queue.entries().next();
    if (next.done) {
      return;
    }
    const [id, fn] = next.value;
    this.queue.delete(id);
    fn();
  }
}
