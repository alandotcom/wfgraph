/**
 * Timer queue the replay driver owns for one `driveWithReplay` call.
 *
 * A pass ends when every branch is parked on a step port, and "parked" is the
 * absence of work the driver can still run. Host timers between two step calls
 * look like that absence unless they land on this queue, so the driver patches
 * `setImmediate` / `setTimeout` for the duration of the drive and drains here
 * instead of counting quiet macrotask turns.
 *
 * Pass-local time advances only to flush those timers. It never moves the
 * Inngest virtual clock the driver keeps for sleeps and event waits.
 */

type Task = {
  readonly id: number;
  readonly fn: () => void;
  readonly dueAt: number;
  cancelled: boolean;
};

type HostTimers = {
  setImmediate: typeof globalThis.setImmediate;
  clearImmediate: typeof globalThis.clearImmediate;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
};

/** True while one `PassScheduler.install` owns the host timers. */
let installed = false;

export class PassScheduler {
  private passLocalNow = 0;
  private nextId = 1;
  private readonly immediates: Task[] = [];
  private readonly delayed: Task[] = [];
  private host: HostTimers | null = null;
  private suspended = false;

  /** True when a due immediate or delayed task is waiting to run. */
  hasDue(): boolean {
    if (this.immediates.some((task) => !task.cancelled)) {
      return true;
    }
    return this.delayed.some(
      (task) => !task.cancelled && task.dueAt <= this.passLocalNow
    );
  }

  /** True when a delayed task is waiting past the current pass-local time. */
  hasFuture(): boolean {
    return this.delayed.some(
      (task) => !task.cancelled && task.dueAt > this.passLocalNow
    );
  }

  /** Moves pass-local time to the next delayed deadline. */
  advanceToNextDeadline(): void {
    let next: number | undefined;
    for (const task of this.delayed) {
      if (task.cancelled || task.dueAt <= this.passLocalNow) {
        continue;
      }
      next = next === undefined ? task.dueAt : Math.min(next, task.dueAt);
    }
    if (next !== undefined) {
      this.passLocalNow = next;
    }
  }

  /**
   * Runs every task due now, flushing microtasks between batches so a resolved
   * promise can enqueue the next timer before the drain decides it is idle.
   */
  async drainUntilIdle(): Promise<void> {
    for (;;) {
      while (this.hasDue()) {
        this.runNextDue();
      }
      // eslint-disable-next-line eslint/no-await-in-loop -- microtasks scheduled by the last batch must land before the next hasDue check
      await Promise.resolve();
      if (!this.hasDue()) {
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
        "PassScheduler is already installed. driveWithReplay cannot nest."
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
        "PassScheduler.uninstall called without a matching install."
      );
    }
    this.restoreGlobals();
    this.host = null;
    installed = false;
    this.immediates.length = 0;
    this.delayed.length = 0;
    this.passLocalNow = 0;
    this.suspended = false;
  }

  /**
   * Restores host timers for work that must use the real clock (step callbacks
   * in the replay half), then re-patches when the callback returns.
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
    if (!this.host || this.suspended) {
      return;
    }
    this.restoreGlobals();
    this.suspended = true;
  }

  private resume(): void {
    if (!this.host || !this.suspended) {
      return;
    }
    this.suspended = false;
    this.patchGlobals();
  }

  private patchGlobals(): void {
    // Host timer types carry Node promisify brands; the queue returns plain ids.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- see above
    globalThis.setImmediate = ((
      fn: (...args: unknown[]) => void,
      ...args: unknown[]
    ) =>
      this.enqueueImmediate(() =>
        fn(...args)
      )) as unknown as typeof setImmediate;

    globalThis.clearImmediate = (id: unknown) => {
      this.cancel(timerId(id));
    };

    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- see above
    globalThis.setTimeout = ((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const delay = Math.max(0, ms ?? 0);
      const run = () => fn(...args);
      return delay === 0
        ? this.enqueueImmediate(run)
        : this.enqueueDelayed(delay, run);
    }) as unknown as typeof setTimeout;

    globalThis.clearTimeout = (id: unknown) => {
      this.cancel(timerId(id));
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

  private enqueueImmediate(fn: () => void): number {
    const task: Task = {
      id: this.nextId++,
      fn,
      dueAt: this.passLocalNow,
      cancelled: false,
    };
    this.immediates.push(task);
    return task.id;
  }

  private enqueueDelayed(ms: number, fn: () => void): number {
    const task: Task = {
      id: this.nextId++,
      fn,
      dueAt: this.passLocalNow + ms,
      cancelled: false,
    };
    this.delayed.push(task);
    return task.id;
  }

  private cancel(id: number): void {
    for (const task of this.immediates) {
      if (task.id === id) {
        task.cancelled = true;
        return;
      }
    }
    for (const task of this.delayed) {
      if (task.id === id) {
        task.cancelled = true;
        return;
      }
    }
  }

  private runNextDue(): void {
    while (this.immediates.length > 0) {
      const task = this.immediates.shift();
      if (!task || task.cancelled) {
        continue;
      }
      task.fn();
      return;
    }

    let bestIndex = -1;
    let bestDue = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.delayed.length; i += 1) {
      const task = this.delayed[i];
      if (task.cancelled || task.dueAt > this.passLocalNow) {
        continue;
      }
      if (task.dueAt < bestDue) {
        bestDue = task.dueAt;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) {
      return;
    }
    const [task] = this.delayed.splice(bestIndex, 1);
    if (!task.cancelled) {
      task.fn();
    }
  }
}

/** A handle this scheduler handed out, or zero when the host passed something else. */
function timerId(id: unknown): number {
  return typeof id === "number" ? id : 0;
}
