import { describe, expect, it } from "vitest";
import {
  countStepFailure,
  decideRelease,
  exitWakeForClaim,
  runRetriesSpent,
  STEP_RETRY_LIMIT,
  sweptStepFailures,
  UNDATED_PARK_WAKE_AT,
} from "#src/backend/services/executions/repo/release-policy";

const NOW = new Date("2026-03-01T09:00:00.000Z");

function after(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

describe("countStepFailure", () => {
  it("fails a step on the failure that passes the retry limit", () => {
    const counts = [];
    let row = countStepFailure(undefined, "down");
    while (row !== null && row.status === "failing") {
      counts.push(row.failures);
      row = countStepFailure(row, "down");
    }
    expect(counts).toEqual([1, 2, 3, 4]);
    expect(row).toEqual({
      status: "failed",
      failures: STEP_RETRY_LIMIT + 1,
      error: "down",
    });
  });

  it("leaves a row that already succeeded or failed alone", () => {
    expect(
      countStepFailure({ status: "succeeded", failures: 2, value: 1 }, "down")
    ).toBeNull();
    expect(
      countStepFailure({ status: "failed", failures: 5, error: "x" }, "down")
    ).toBeNull();
  });
});

describe("runRetriesSpent", () => {
  it("spends the run's retries past the same limit a step has", () => {
    expect(runRetriesSpent(STEP_RETRY_LIMIT)).toBe(false);
    expect(runRetriesSpent(STEP_RETRY_LIMIT + 1)).toBe(true);
  });
});

describe("sweptStepFailures", () => {
  it("counts an expired lease against the step its row recorded, and nothing for a row that was not leased", () => {
    expect(
      sweptStepFailures([
        { id: "sched_1", state: "leased", runningStepId: "step_a" },
        { id: "sched_2", state: "leased", runningStepId: null },
        { id: "sched_3", state: "queued", runningStepId: null },
      ])
    ).toEqual([{ scheduleId: "sched_1", stepId: "step_a" }]);
  });
});

describe("decideRelease", () => {
  const failing = { status: "failing", failures: 1, error: "down" } as const;

  it("waits out a failing step's backoff, and re-queues a failed step at once", () => {
    const outcome = {
      kind: "step_failed",
      stepId: "step_a",
      error: "down",
      backoffMs: 2_000,
    } as const;
    expect(
      decideRelease({
        outcome,
        attempt: 3,
        now: NOW,
        parks: [],
        countedStep: failing,
      })
    ).toEqual({
      state: "queued",
      wakeAt: after(2_000),
      attempt: 0,
      lastError: "down",
    });
    expect(
      decideRelease({
        outcome,
        attempt: 3,
        now: NOW,
        parks: [],
        countedStep: { ...failing, status: "failed", failures: 5 },
      })
    ).toMatchObject({ state: "queued", wakeAt: NOW, attempt: 0 });
  });

  it("counts a failure no step owns against the run, and resets the count on every other outcome", () => {
    expect(
      decideRelease({
        outcome: { kind: "run_failed", error: "boom", backoffMs: 1_000 },
        attempt: 2,
        now: NOW,
        parks: [],
        countedStep: null,
      })
    ).toEqual({
      state: "queued",
      wakeAt: after(1_000),
      attempt: 3,
      lastError: "boom",
    });
    expect(
      decideRelease({
        outcome: { kind: "fence_refused" },
        attempt: 2,
        now: NOW,
        parks: [],
        countedStep: null,
      })
    ).toEqual({ state: "queued", wakeAt: NOW, attempt: 0, lastError: null });
  });

  it("sleeps a parked run until its earliest deadline, and re-queues one holding an unconsumed wake", () => {
    const parked = { kind: "parked" } as const;
    expect(
      decideRelease({
        outcome: parked,
        attempt: 1,
        now: NOW,
        parks: [
          { status: "waiting", waitUntil: after(9_000), woken: false },
          { status: "waiting", waitUntil: after(4_000), woken: false },
        ],
        countedStep: null,
      })
    ).toEqual({
      state: "waiting",
      wakeAt: after(4_000),
      attempt: 0,
      lastError: null,
    });
    expect(
      decideRelease({
        outcome: parked,
        attempt: 0,
        now: NOW,
        parks: [{ status: "waiting", waitUntil: null, woken: false }],
        countedStep: null,
      }).wakeAt
    ).toEqual(UNDATED_PARK_WAKE_AT);
    expect(
      decideRelease({
        outcome: parked,
        attempt: 0,
        now: NOW,
        parks: [
          { status: "waiting", waitUntil: after(4_000), woken: false },
          { status: "resuming", waitUntil: after(9_000), woken: true },
        ],
        countedStep: null,
      })
    ).toMatchObject({ state: "queued", wakeAt: NOW });
  });
});

describe("exitWakeForClaim", () => {
  it("resolves the run's other parks only for the pass whose claim wrote", () => {
    const state = {
      executionId: "exec_1",
      status: "running",
      claim: null,
    } as const;
    expect(exitWakeForClaim({ ...state, didWrite: true })).toEqual({
      kind: "exit",
    });
    expect(exitWakeForClaim({ ...state, didWrite: false })).toBeNull();
    expect(exitWakeForClaim(null)).toBeNull();
  });
});
