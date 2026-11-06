/**
 * The replay driver's own cases: a parked pass ends the body, and the run wakes
 * when any one of its parks resolves.
 */

import { expect, it } from "vitest";
import type {
  WaitAnswer,
  WaitWake,
  WorkflowExecutionRuntime,
} from "#src/backend/engine/runtime";
import {
  driveWithReplay,
  type ReplayExecutor,
} from "#src/backend/engine/testing/replay-runtime";
import { CANCEL_WAKE } from "#src/backend/engine/testing/wait-fixtures";

/** What a body answers for a pass that ended with a park open. */
export const PARKED_PASS = { kind: "parked" } as const;

/**
 * A step reference from its id alone. These cases are about when the driver
 * wakes a run, so none of them has a display name to state.
 */
export const stepRef = (id: string) => ({ id });

/**
 * A park with no answer, which the driver ends at its timeout. The Wait node is
 * the only thing that suspends a run, so a park is how these cases hold one.
 * Each park stands on a wait row of its own, named after its step.
 */
export const park = (
  runtime: WorkflowExecutionRuntime,
  id: string,
  timeoutMs: number
): Promise<WaitAnswer> =>
  runtime.waitForEvent(stepRef(id), {
    timeoutMs,
    waitStateId: id,
  });

/** Whether a park is still open, which ends the pass. */
export const isParked = (answer: WaitAnswer): boolean =>
  answer.kind === "parked";

export function defineReplayRuntimeCases(executor: ReplayExecutor): void {
  it("runs a chain of steps", async () => {
    const run = await driveWithReplay(
      async (runtime) => {
        const first = await runtime.run(stepRef("first"), () =>
          Promise.resolve(1)
        );
        const second = await runtime.run(stepRef("second"), () =>
          Promise.resolve(first + 1)
        );
        return second;
      },
      { executor }
    );

    expect(run.value).toBe(2);
    expect(run.executed.map((step) => step.stepId)).toEqual([
      "first",
      "second",
    ]);
    expect(run.elapsedMs).toBe(0);
  });

  it("moves the clock to a park's target", async () => {
    const run = await driveWithReplay(
      async (runtime) => {
        if (isParked(await park(runtime, "nap", 5_000))) {
          return PARKED_PASS;
        }
        return await runtime.run(stepRef("after"), () =>
          Promise.resolve("done")
        );
      },
      { executor }
    );

    expect(run.value).toBe("done");
    expect(run.elapsedMs).toBe(5_000);
    expect(run.executed).toEqual([
      { run: "root", invocation: 1, at: 5_000, stepId: "after" },
    ]);
  });

  it("resolves an event wait from the answer it was given", async () => {
    const resume: WaitWake = {
      kind: "resume",
      eventName: "app/approved",
      payload: { token: "abc" },
    };
    const run = await driveWithReplay(
      async (runtime) => {
        const answer = await park(runtime, "signal", 1_000);
        return answer.kind === "parked" ? PARKED_PASS : answer.wake;
      },
      { executor, events: { signal: resume } }
    );

    expect(run.value).toEqual(resume);
    expect(run.elapsedMs).toBe(1_000);
  });

  it("reads an event wait with no answer as a timeout", async () => {
    const run = await driveWithReplay(
      async (runtime) => {
        const answer = await park(runtime, "signal", 2_000);
        return answer.kind === "parked" ? PARKED_PASS : answer.wake;
      },
      { executor }
    );

    expect(run.value).toEqual({ kind: "timeout" });
    expect(run.elapsedMs).toBe(2_000);
  });

  it("runs a parked body again once its park resolves, answering earlier steps from the memo", async () => {
    let calls = 0;
    const run = await driveWithReplay(
      async (runtime) => {
        await runtime.run(stepRef("before"), () => {
          calls += 1;
          return Promise.resolve(null);
        });
        if (isParked(await park(runtime, "nap", 5_000))) {
          return PARKED_PASS;
        }
        return await runtime.run(stepRef("after"), () =>
          Promise.resolve("done")
        );
      },
      { executor }
    );

    expect(run.value).toBe("done");
    expect(calls).toBe(1);
    // The first pass ran its step inline and parked; the second ran the rest.
    expect(run.invocations).toBe(2);
    expect(run.executed).toEqual([
      { run: "root", invocation: 0, at: 0, stepId: "before" },
      { run: "root", invocation: 1, at: 5_000, stepId: "after" },
    ]);
  });

  // A 20s park beside a 90s park resolves on its own, so the branch behind it
  // is not held for the other.
  it("wakes the run when any one park resolves, each on a pass of its own", async () => {
    const run = await driveWithReplay(
      async (runtime) => {
        const branchBehind = async (id: string, timeoutMs: number) => {
          if (isParked(await park(runtime, id, timeoutMs))) {
            return "parked";
          }
          await runtime.run(stepRef(`after-${id}`), () => Promise.resolve(1));
          return "done";
        };
        const ends = await Promise.all([
          branchBehind("short", 20_000),
          branchBehind("long", 90_000),
        ]);
        return ends.includes("parked") ? PARKED_PASS : "done";
      },
      { executor }
    );

    expect(run.executed.map((step) => `${step.stepId}@${step.at}`)).toEqual([
      "after-short@20000",
      "after-long@90000",
    ]);
    expect(run.invocations).toBe(3);
    expect(run.elapsedMs).toBe(90_000);
  });

  it("resolves a park nothing answered as a timeout at the deadline it first parked with", async () => {
    const run = await driveWithReplay(
      async (runtime, pass) => {
        // A Wait asks again with the time left, which shrinks between passes.
        const answer = await park(runtime, "nap", 3_000 - pass.invocation);
        return answer.kind === "parked" ? PARKED_PASS : answer.wake;
      },
      { executor }
    );

    expect(run.value).toEqual({ kind: "timeout" });
    expect(run.elapsedMs).toBe(3_000);
    expect(run.invocations).toBe(2);
  });

  it("runs the body again at once for a wake that lands during the pass", async () => {
    const run = await driveWithReplay(
      async (runtime, pass) => {
        const answer = await park(runtime, "nap", 600_000);
        if (answer.kind === "woke") {
          return answer.wake;
        }
        await pass.signalOpenParks(CANCEL_WAKE);
        return PARKED_PASS;
      },
      { executor }
    );

    expect(run.value).toEqual(CANCEL_WAKE);
    expect(run.elapsedMs).toBe(0);
    expect(run.invocations).toBe(2);
  });

  it("signals every park open at the producer's moment, after its own writes", async () => {
    const writes: number[] = [];
    const run = await driveWithReplay(
      async (runtime) => {
        const answers = await Promise.all([
          park(runtime, "first", 600_000),
          park(runtime, "second", 900_000),
        ]);
        return answers.some(isParked)
          ? PARKED_PASS
          : answers.map((answer) => answer.kind === "woke" && answer.wake);
      },
      {
        executor: {
          ...executor,
          signalOpenParksAt: {
            atMs: 30_000,
            wake: CANCEL_WAKE,
            write: () => writes.push(writes.length),
          },
        },
      }
    );

    expect(run.value).toEqual([CANCEL_WAKE, CANCEL_WAKE]);
    expect(writes).toEqual([0]);
    expect(run.elapsedMs).toBe(30_000);
    expect(run.invocations).toBe(2);
  });

  it("ends the drive with what a step threw", async () => {
    await expect(
      driveWithReplay(
        async (runtime) =>
          await runtime.run(stepRef("broken"), () =>
            Promise.reject(new Error("the step failed"))
          ),
        { executor }
      )
    ).rejects.toThrow("the step failed");
  });

  it("refuses a pass that ended parked with no park open to wake it", async () => {
    await expect(
      driveWithReplay(() => Promise.resolve(PARKED_PASS), { executor })
    ).rejects.toThrow(/no open park left to wake the run/);
  });
}
