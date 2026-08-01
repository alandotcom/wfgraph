/**
 * Coverage for the replay driver itself, so the engine tests that stand on it
 * are standing on a stated model rather than on an assumption.
 *
 * The third case is the one that matters: it pins the executor policy the driver
 * was built to reproduce, which is that a run holding an outstanding pause
 * advances one step boundary per wake.
 */

import { describe, expect, it } from "vitest";
import { driveWithReplay } from "#src/backend/engine/replay-runtime";

describe("driveWithReplay", () => {
  it("runs a chain of steps, calling the body again after each", async () => {
    const run = await driveWithReplay(async (runtime) => {
      const first = await runtime.run("first", () => Promise.resolve(1));
      const second = await runtime.run("second", () =>
        Promise.resolve(first + 1)
      );
      return second;
    });

    expect(run.value).toBe(2);
    expect(run.executed.map((step) => step.stepId)).toEqual([
      "first",
      "second",
    ]);
    expect(run.elapsedMs).toBe(0);
  });

  it("answers a replayed step out of the memo rather than running it twice", async () => {
    let calls = 0;
    const run = await driveWithReplay(async (runtime) => {
      const value = await runtime.run("once", () => {
        calls += 1;
        return Promise.resolve("value");
      });
      await runtime.run("after", () => Promise.resolve(null));
      return value;
    });

    expect(run.value).toBe("value");
    expect(calls).toBe(1);
    expect(run.invocations).toBeGreaterThan(2);
  });

  it("moves the clock to a sleep's target", async () => {
    const run = await driveWithReplay(async (runtime) => {
      await runtime.sleep("nap", 5_000);
      return await runtime.run("after", () => Promise.resolve("done"));
    });

    expect(run.value).toBe("done");
    expect(run.elapsedMs).toBe(5_000);
    expect(run.executed).toEqual([
      { invocation: 1, at: 5_000, stepId: "after" },
    ]);
  });

  it("holds a sibling branch at its next step boundary while a sleep is outstanding", async () => {
    const run = await driveWithReplay(async (runtime) => {
      const parked = runtime.sleep("nap", 60_000);
      const busy = (async () => {
        await runtime.run("first", () => Promise.resolve(1));
        await runtime.run("second", () => Promise.resolve(2));
      })();

      await Promise.all([parked, busy]);
      return "done";
    });

    const clockFor = (stepId: string) =>
      run.executed.find((step) => step.stepId === stepId)?.at;

    // The pass that reached the sleep had already asked for `first`, so that one
    // runs. `second` belongs to the pass that never came.
    expect(clockFor("first")).toBe(0);
    expect(clockFor("second")).toBe(60_000);
  });

  it("wakes two outstanding sleeps together, at the later target", async () => {
    const run = await driveWithReplay(async (runtime) => {
      const short = (async () => {
        await runtime.sleep("short", 20_000);
        await runtime.run("afterShort", () => Promise.resolve(1));
      })();
      const long = (async () => {
        await runtime.sleep("long", 90_000);
        await runtime.run("afterLong", () => Promise.resolve(1));
      })();

      await Promise.all([short, long]);
      return "done";
    });

    // Measured against `inngest dev`: a 20s sleep beside a 90s sleep resumed at
    // the 90s mark, so the branch behind the shorter one is 70 seconds late.
    expect(run.executed.map((step) => `${step.stepId}@${step.at}`)).toEqual([
      "afterShort@90000",
      "afterLong@90000",
    ]);
  });

  it("resolves an event wait from the answer it was given", async () => {
    const run = await driveWithReplay(
      async (runtime) =>
        await runtime.waitForEvent("signal", {
          event: "workflow/wait.signal",
          timeoutMs: 1_000,
        }),
      { events: { signal: { data: { token: "abc" } } } }
    );

    expect(run.value).toEqual({ data: { token: "abc" } });
    expect(run.elapsedMs).toBe(1_000);
  });

  it("reads an event wait with no answer as a timeout", async () => {
    const run = await driveWithReplay(
      async (runtime) =>
        await runtime.waitForEvent("signal", {
          event: "workflow/wait.signal",
          timeoutMs: 2_000,
        })
    );

    expect(run.value).toBeNull();
    expect(run.elapsedMs).toBe(2_000);
  });

  it("gives up on a body that asks for nothing and never returns", async () => {
    await expect(
      driveWithReplay(() => new Promise(() => undefined))
    ).rejects.toThrow(/blocked on something the runtime does not own/);
  });
});
