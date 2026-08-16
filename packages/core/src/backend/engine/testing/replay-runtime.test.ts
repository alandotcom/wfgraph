/**
 * Coverage for the replay driver itself, so the engine tests that stand on it
 * are standing on a stated model rather than on an assumption.
 *
 * Two cases carry the executor policy the driver was built to reproduce: a run
 * holding an outstanding pause advances one step boundary per wake and wakes at
 * the last of its pauses, and that ceiling belongs to one run rather than to
 * the tree.
 */

import { describe, expect, it } from "vitest";
import type { BranchRunResult } from "#src/backend/engine/branch";
import { driveWithReplay } from "#src/backend/engine/testing/replay-runtime";

/** A branch body's answer, which the driver hands to whoever started it. */
const NOTHING_RAN: BranchRunResult = { results: {}, outputs: {} };

/**
 * A step reference from its id alone. These cases are about when the driver
 * wakes a run, so none of them has a display name to state.
 */
const stepRef = (id: string) => ({ id });

describe("driveWithReplay", () => {
  it("runs a chain of steps, calling the body again after each", async () => {
    const run = await driveWithReplay(async (runtime) => {
      const first = await runtime.run(stepRef("first"), () =>
        Promise.resolve(1)
      );
      const second = await runtime.run(stepRef("second"), () =>
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
      const value = await runtime.run(stepRef("once"), () => {
        calls += 1;
        return Promise.resolve("value");
      });
      await runtime.run(stepRef("after"), () => Promise.resolve(null));
      return value;
    });

    expect(run.value).toBe("value");
    expect(calls).toBe(1);
    expect(run.invocations).toBeGreaterThan(2);
  });

  it("moves the clock to a sleep's target", async () => {
    const run = await driveWithReplay(async (runtime) => {
      await runtime.sleep(stepRef("nap"), 5_000);
      return await runtime.run(stepRef("after"), () => Promise.resolve("done"));
    });

    expect(run.value).toBe("done");
    expect(run.elapsedMs).toBe(5_000);
    expect(run.executed).toEqual([
      { run: "root", invocation: 1, at: 5_000, stepId: "after" },
    ]);
  });

  it("holds a sibling branch at its next step boundary while a sleep is outstanding", async () => {
    const run = await driveWithReplay(async (runtime) => {
      const parked = runtime.sleep(stepRef("nap"), 60_000);
      const busy = (async () => {
        await runtime.run(stepRef("first"), () => Promise.resolve(1));
        await runtime.run(stepRef("second"), () => Promise.resolve(2));
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
        await runtime.sleep(stepRef("short"), 20_000);
        await runtime.run(stepRef("afterShort"), () => Promise.resolve(1));
      })();
      const long = (async () => {
        await runtime.sleep(stepRef("long"), 90_000);
        await runtime.run(stepRef("afterLong"), () => Promise.resolve(1));
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
        await runtime.waitForEvent(stepRef("signal"), {
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
        await runtime.waitForEvent(stepRef("signal"), {
          event: "workflow/wait.signal",
          timeoutMs: 2_000,
        })
    );

    expect(run.value).toBeNull();
    expect(run.elapsedMs).toBe(2_000);
  });

  it("wakes each branch run at its own pause rather than at the tree's last", async () => {
    const sleepFor: Record<string, number> = { short: 20_000, long: 90_000 };

    const run = await driveWithReplay(
      async (runtime) => {
        await Promise.all([
          runtime.startBranch?.(stepRef("branch-short"), {
            entryNodeId: "short",
            releasedNodeIds: [],
          }),
          runtime.startBranch?.(stepRef("branch-long"), {
            entryNodeId: "long",
            releasedNodeIds: [],
          }),
        ]);
        return "done";
      },
      {
        branch: async (runtime, { entryNodeId }) => {
          await runtime.sleep(
            stepRef(`wait-${entryNodeId}`),
            sleepFor[entryNodeId]
          );
          await runtime.run(stepRef(`after-${entryNodeId}`), () =>
            Promise.resolve(null)
          );
          return NOTHING_RAN;
        },
      }
    );

    // The root and one run per branch. Each branch holds one pause, so the
    // twenty-second one lands on its own target instead of on its sibling's.
    expect(run.runs).toBe(3);
    expect(run.executed.map((step) => `${step.stepId}@${step.at}`)).toEqual([
      "after-short@20000",
      "after-long@90000",
    ]);
    expect(run.elapsedMs).toBe(90_000);
  });

  it("registers a short branch sleep at its own target after a macrotask between steps", async () => {
    const sleepFor: Record<string, number> = { short: 20_000, long: 90_000 };

    const run = await driveWithReplay(
      async (runtime) => {
        await Promise.all([
          runtime.startBranch?.(stepRef("branch-short"), {
            entryNodeId: "short",
            releasedNodeIds: [],
          }),
          runtime.startBranch?.(stepRef("branch-long"), {
            entryNodeId: "long",
            releasedNodeIds: [],
          }),
        ]);
        return "done";
      },
      {
        branch: async (runtime, { entryNodeId }) => {
          await runtime.run(stepRef(`prepare-${entryNodeId}`), () =>
            Promise.resolve(null)
          );
          // Host macrotask between step ports: under quiet-turn quiescence the
          // pass ended here and the short sleep registered after the long
          // sibling had already advanced the clock.
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          await runtime.sleep(
            stepRef(`wait-${entryNodeId}`),
            sleepFor[entryNodeId]
          );
          await runtime.run(stepRef(`after-${entryNodeId}`), () =>
            Promise.resolve(null)
          );
          return NOTHING_RAN;
        },
      }
    );

    const at = (stepId: string) =>
      run.executed.find((step) => step.stepId === stepId)?.at;

    expect(at("after-short")).toBeLessThan(60_000);
    expect(at("after-long")).toBe(90_000);
    expect(run.elapsedMs).toBe(90_000);
  });

  it("hands what a branch returned back to the run that started it", async () => {
    const answered: BranchRunResult = {
      results: { reminder: { success: true, data: { sent: true } } },
      outputs: { reminder: { label: "Reminder", data: { sent: true } } },
    };

    const run = await driveWithReplay(
      async (runtime) =>
        await runtime.startBranch?.(stepRef("branch-wait"), {
          entryNodeId: "wait",
          releasedNodeIds: [],
        }),
      { branch: () => Promise.resolve(answered) }
    );

    expect(run.value).toEqual({ status: "finished", result: answered });
  });

  it("rejects the hand-off with what the branch threw", async () => {
    await expect(
      driveWithReplay(
        async (runtime) =>
          await runtime.startBranch?.(stepRef("branch-wait"), {
            entryNodeId: "wait",
            releasedNodeIds: [],
          }),
        { branch: () => Promise.reject(new Error("the branch died")) }
      )
    ).rejects.toThrow("the branch died");
  });

  it("answers killed for a branch the cancel reached mid-sleep", async () => {
    const run = await driveWithReplay(
      async (runtime) =>
        await runtime.startBranch?.(stepRef("branch-wait"), {
          entryNodeId: "wait",
          releasedNodeIds: [],
        }),
      {
        branch: async (runtime) => {
          await runtime.sleep(stepRef("wait-long"), 600_000);
          await runtime.run(stepRef("after"), () => Promise.resolve(null));
          return NOTHING_RAN;
        },
        killBranchesAtMs: 30_000,
      }
    );

    expect(run.value).toEqual({ status: "killed" });
    // The step behind the sleep never ran, and the tree ended at the kill
    // rather than at the branch's own target.
    expect(run.executed).toEqual([]);
    expect(run.elapsedMs).toBe(30_000);
  });

  it("gives up on a body that asks for nothing and never returns", async () => {
    await expect(
      driveWithReplay(() => new Promise(() => undefined))
    ).rejects.toThrow(/blocked on something the runtime does not own/);
  });
});
