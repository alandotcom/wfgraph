/**
 * Coverage for the host-timer queue itself: install/uninstall, cancel, drain,
 * and nested `withHostTimers`, so the replay driver's quiescence is standing
 * on a stated model rather than on the one end-to-end regression alone.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ReplayHostTimers } from "#src/backend/engine/replay-host-timers";

describe("ReplayHostTimers", () => {
  const hostImmediate = globalThis.setImmediate;
  const hostClearImmediate = globalThis.clearImmediate;
  const hostTimeout = globalThis.setTimeout;
  const hostClearTimeout = globalThis.clearTimeout;

  afterEach(() => {
    globalThis.setImmediate = hostImmediate;
    globalThis.clearImmediate = hostClearImmediate;
    globalThis.setTimeout = hostTimeout;
    globalThis.clearTimeout = hostClearTimeout;
  });

  it("refuses a second install while one drive owns the globals", () => {
    const first = new ReplayHostTimers();
    first.install();
    try {
      expect(() => new ReplayHostTimers().install()).toThrow(
        /already installed/
      );
    } finally {
      first.uninstall();
    }
  });

  it("restores host timers on uninstall even after a body throw", async () => {
    const timers = new ReplayHostTimers();
    timers.install();
    try {
      throw new Error("body failed");
    } catch {
      timers.uninstall();
    }
    expect(globalThis.setImmediate).toBe(hostImmediate);
    expect(globalThis.setTimeout).toBe(hostTimeout);
  });

  it("drains a setImmediate onto the queue before returning", async () => {
    const timers = new ReplayHostTimers();
    timers.install();
    try {
      let ran = false;
      setImmediate(() => {
        ran = true;
      });
      expect(timers.hasPending()).toBe(true);
      await timers.drainUntilIdle();
      expect(ran).toBe(true);
      expect(timers.hasPending()).toBe(false);
    } finally {
      timers.uninstall();
    }
  });

  it("treats setTimeout(0) as an immediate and refuses a positive delay", async () => {
    const timers = new ReplayHostTimers();
    timers.install();
    try {
      let ran = false;
      setTimeout(() => {
        ran = true;
      }, 0);
      await timers.drainUntilIdle();
      expect(ran).toBe(true);

      expect(() => {
        setTimeout(() => undefined, 1);
      }).toThrow(/does not own delayed setTimeout/);
    } finally {
      timers.uninstall();
    }
  });

  it("deletes a cancelled immediate so drain does not run it", async () => {
    const timers = new ReplayHostTimers();
    timers.install();
    try {
      let ran = false;
      const id = setImmediate(() => {
        ran = true;
      });
      clearImmediate(id);
      expect(timers.hasPending()).toBe(false);
      await timers.drainUntilIdle();
      expect(ran).toBe(false);
    } finally {
      timers.uninstall();
    }
  });

  it("restores host timers for withHostTimers and re-patches after", async () => {
    const timers = new ReplayHostTimers();
    timers.install();
    try {
      await timers.withHostTimers(async () => {
        expect(globalThis.setImmediate).toBe(hostImmediate);
        let fired = false;
        await new Promise<void>((resolve) => {
          hostTimeout(() => {
            fired = true;
            resolve();
          }, 1);
        });
        expect(fired).toBe(true);
      });
      expect(globalThis.setImmediate).not.toBe(hostImmediate);

      let queued = false;
      setImmediate(() => {
        queued = true;
      });
      expect(timers.hasPending()).toBe(true);
      await timers.drainUntilIdle();
      expect(queued).toBe(true);
    } finally {
      timers.uninstall();
    }
  });

  it("keeps host timers for nested withHostTimers until the outer returns", async () => {
    const timers = new ReplayHostTimers();
    timers.install();
    try {
      await timers.withHostTimers(async () => {
        expect(globalThis.setImmediate).toBe(hostImmediate);
        await timers.withHostTimers(async () => {
          expect(globalThis.setImmediate).toBe(hostImmediate);
        });
        expect(globalThis.setImmediate).toBe(hostImmediate);
      });
      expect(globalThis.setImmediate).not.toBe(hostImmediate);
    } finally {
      timers.uninstall();
    }
  });

  it("re-patches after withHostTimers rejects", async () => {
    const timers = new ReplayHostTimers();
    timers.install();
    try {
      await expect(
        timers.withHostTimers(() => Promise.reject(new Error("step failed")))
      ).rejects.toThrow("step failed");
      expect(globalThis.setImmediate).not.toBe(hostImmediate);
    } finally {
      timers.uninstall();
    }
  });
});
