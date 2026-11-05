/**
 * Coverage for the replay driver itself, so the engine tests that stand on it
 * are standing on a stated model rather than on an assumption.
 *
 * Two cases carry the Inngest policy the driver was built to reproduce: a run
 * holding an outstanding pause advances one step boundary per wake and wakes at
 * the last of its pauses, and that ceiling belongs to one run rather than to
 * the tree. The database executor's cases carry its policy instead: a parked
 * pass ends the body, and the run wakes when any one of its parks resolves.
 * Those, and the cases both executors share, live in
 * `replay-runtime.replay-cases.ts` so the replay suite runners can run them on
 * a real database too.
 */

import { describe, expect, it } from "vitest";
import type { BranchRunResult } from "#src/backend/engine/branch";
import type { WaitWake } from "#src/backend/engine/runtime";
import {
  createInMemoryReplayBackend,
  type ReplayDatabaseBackend,
} from "#src/backend/engine/testing/replay-database-executor";
import {
  driveWithReplay,
  IN_PLACE_EXECUTORS,
} from "#src/backend/engine/testing/replay-runtime";
import {
  defineReplayRuntimeCases,
  isParked,
  PARKED_PASS,
  park,
  stepRef,
} from "#src/backend/engine/testing/replay-runtime.replay-cases";

/** A branch body's answer, which the driver hands to whoever started it. */
const NOTHING_RAN: BranchRunResult = { results: {}, outputs: {} };

describe.each(IN_PLACE_EXECUTORS)(
  "driveWithReplay under the $kind executor",
  defineReplayRuntimeCases
);

describe("driveWithReplay, Inngest executor only", () => {
  it("calls the body again after each step", async () => {
    const run = await driveWithReplay(async (runtime) => {
      await runtime.run(stepRef("first"), () => Promise.resolve(1));
      await runtime.run(stepRef("second"), () => Promise.resolve(2));
      return null;
    });

    // One invocation discovers each step, and one more returns.
    expect(run.invocations).toBe(3);
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

  it("holds a sibling branch at its next step boundary while a park is outstanding", async () => {
    const run = await driveWithReplay(async (runtime) => {
      const parked = park(runtime, "nap", 60_000);
      const busy = (async () => {
        await runtime.run(stepRef("first"), () => Promise.resolve(1));
        await runtime.run(stepRef("second"), () => Promise.resolve(2));
      })();

      await Promise.all([parked, busy]);
      return "done";
    });

    const clockFor = (stepId: string) =>
      run.executed.find((step) => step.stepId === stepId)?.at;

    // The pass that reached the park had already asked for `first`, so that one
    // runs. `second` belongs to the pass that never came.
    expect(clockFor("first")).toBe(0);
    expect(clockFor("second")).toBe(60_000);
  });

  it("wakes two outstanding parks together, at the later target", async () => {
    const run = await driveWithReplay(async (runtime) => {
      const short = (async () => {
        await park(runtime, "short", 20_000);
        await runtime.run(stepRef("afterShort"), () => Promise.resolve(1));
      })();
      const long = (async () => {
        await park(runtime, "long", 90_000);
        await runtime.run(stepRef("afterLong"), () => Promise.resolve(1));
      })();

      await Promise.all([short, long]);
      return "done";
    });

    // Measured against `inngest dev`: a 20s park beside a 90s park resumed at
    // the 90s mark, so the branch behind the shorter one is 70 seconds late.
    expect(run.executed.map((step) => `${step.stepId}@${step.at}`)).toEqual([
      "afterShort@90000",
      "afterLong@90000",
    ]);
  });

  it("wakes each branch run at its own pause rather than at the tree's last", async () => {
    const parkFor: Record<string, number> = { short: 20_000, long: 90_000 };

    const run = await driveWithReplay(
      async (runtime) => {
        await Promise.all([
          runtime.startBranch?.(stepRef("branch-short"), {
            entryNodeId: "short",
            releasedEdges: [],
            side: "started",
          }),
          runtime.startBranch?.(stepRef("branch-long"), {
            entryNodeId: "long",
            releasedEdges: [],
            side: "started",
          }),
        ]);
        return "done";
      },
      {
        executor: {
          kind: "inngest",
          branch: async (runtime, { entryNodeId }) => {
            await park(runtime, `wait-${entryNodeId}`, parkFor[entryNodeId]);
            await runtime.run(stepRef(`after-${entryNodeId}`), () =>
              Promise.resolve(null)
            );
            return NOTHING_RAN;
          },
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

  it("registers a short branch park at its own target after a macrotask between steps", async () => {
    const parkFor: Record<string, number> = { short: 20_000, long: 90_000 };

    const run = await driveWithReplay(
      async (runtime) => {
        await Promise.all([
          runtime.startBranch?.(stepRef("branch-short"), {
            entryNodeId: "short",
            releasedEdges: [],
            side: "started",
          }),
          runtime.startBranch?.(stepRef("branch-long"), {
            entryNodeId: "long",
            releasedEdges: [],
            side: "started",
          }),
        ]);
        return "done";
      },
      {
        executor: {
          kind: "inngest",
          branch: async (runtime, { entryNodeId }) => {
            await runtime.run(stepRef(`prepare-${entryNodeId}`), () =>
              Promise.resolve(null)
            );
            // Host macrotask between step ports: under quiet-turn quiescence
            // the pass ended here and the short park registered after the long
            // sibling had already advanced the clock.
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            await park(runtime, `wait-${entryNodeId}`, parkFor[entryNodeId]);
            await runtime.run(stepRef(`after-${entryNodeId}`), () =>
              Promise.resolve(null)
            );
            return NOTHING_RAN;
          },
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
          releasedEdges: [],
          side: "started",
        }),
      {
        executor: { kind: "inngest", branch: () => Promise.resolve(answered) },
      }
    );

    expect(run.value).toEqual({ status: "finished", result: answered });
  });

  it("rejects the hand-off with what the branch threw", async () => {
    await expect(
      driveWithReplay(
        async (runtime) =>
          await runtime.startBranch?.(stepRef("branch-wait"), {
            entryNodeId: "wait",
            releasedEdges: [],
            side: "started",
          }),
        {
          executor: {
            kind: "inngest",
            branch: () => Promise.reject(new Error("the branch died")),
          },
        }
      )
    ).rejects.toThrow("the branch died");
  });

  it("answers killed for a branch the cancel reached while it was parked", async () => {
    const run = await driveWithReplay(
      async (runtime) =>
        await runtime.startBranch?.(stepRef("branch-wait"), {
          entryNodeId: "wait",
          releasedEdges: [],
          side: "started",
        }),
      {
        executor: {
          kind: "inngest",
          branch: async (runtime) => {
            await park(runtime, "wait-long", 600_000);
            await runtime.run(stepRef("after"), () => Promise.resolve(null));
            return NOTHING_RAN;
          },
          killBranchesAtMs: 30_000,
        },
      }
    );

    expect(run.value).toEqual({ status: "killed" });
    // The step behind the park never ran, and the tree ended at the kill
    // rather than at the branch's own target.
    expect(run.executed).toEqual([]);
    expect(run.elapsedMs).toBe(30_000);
  });

  // The run that wins an Exit claim signals every Wait parked in another run.
  // The runs that started it are parked on a branch hand-off, which is no Wait,
  // so they wake only when the branch they started returns.
  it("wakes the Waits other runs are parked on with an Exit signal", async () => {
    const run = await driveWithReplay(
      async (runtime) =>
        await Promise.all([
          runtime.startBranch?.(stepRef("branch-exit"), {
            entryNodeId: "exit",
            releasedEdges: [],
            side: "started",
          }),
          runtime.startBranch?.(stepRef("branch-sibling"), {
            entryNodeId: "sibling",
            releasedEdges: [],
            side: "started",
          }),
        ]),
      {
        executor: {
          kind: "inngest",
          branch: async (runtime, input) => {
            if (input.entryNodeId === "exit") {
              await park(runtime, "wait-short", 30_000);
              await runtime.run(stepRef("wake-parked-waits"), async () => {
                await runtime.wakeParkedWaits?.();
                return null;
              });
              return NOTHING_RAN;
            }
            const woken = await park(runtime, "wait-long", 600_000);
            return {
              results: { sibling: { success: true, data: woken } },
              outputs: {},
            };
          },
        },
      }
    );

    expect(run.value[1]).toEqual({
      status: "finished",
      result: {
        results: {
          sibling: {
            success: true,
            data: { kind: "woke", wake: { kind: "exit" } },
          },
        },
        outputs: {},
      },
    });
    // The sibling woke at the signal rather than at its own target.
    expect(run.elapsedMs).toBe(30_000);
  });

  it("gives up on a body that asks for nothing and never returns", async () => {
    await expect(
      driveWithReplay(() => new Promise(() => undefined))
    ).rejects.toThrow(/blocked on something the runtime does not own/);
  });
});

describe("driveWithReplay, database executor only", () => {
  it("runs each pass against the runtime the backend supplies, and records each wake there", async () => {
    const memory = createInMemoryReplayBackend();
    const passes: number[] = [];
    const resolved: Array<{ stepId: string; wake: WaitWake }> = [];
    const backend: ReplayDatabaseBackend = {
      runtimeForPass: (pass) => {
        passes.push(pass.invocation);
        return memory.runtimeForPass(pass);
      },
      resolvePark: (stepId, wake, at) => {
        resolved.push({ stepId, wake });
        return memory.resolvePark(stepId, wake, at);
      },
    };

    const run = await driveWithReplay(
      async (runtime) =>
        isParked(await park(runtime, "nap", 1_000)) ? PARKED_PASS : "done",
      { executor: { kind: "database", openBackend: () => backend } }
    );

    expect(run.value).toBe("done");
    expect(passes).toEqual([0, 1]);
    expect(resolved).toEqual([{ stepId: "nap", wake: { kind: "timeout" } }]);
  });

  it("answers a park the backend has no wake for as parked", async () => {
    const runtime = await createInMemoryReplayBackend().runtimeForPass({
      invocation: 0,
      now: 0,
    });

    await expect(park(runtime, "nap", 1_000)).resolves.toEqual({
      kind: "parked",
    });
  });
});
