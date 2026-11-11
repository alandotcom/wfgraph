import { describe, expect, it } from "vitest";
import {
  BUDGET_CUT_ERROR,
  countStepFailure,
  decideRelease,
  exitWakeForClaim,
  LEASE_EXPIRED_ERROR,
  retriesSpent,
  STEP_RETRY_LIMIT,
  stepFailureOf,
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
    const down = { error: "down", retriable: true };
    let row = countStepFailure(undefined, down);
    while (row !== null && row.status === "failing") {
      counts.push(row.failures);
      row = countStepFailure(row, down);
    }
    expect(counts).toEqual([1, 2, 3, 4]);
    expect(row).toEqual({
      status: "failed",
      failures: STEP_RETRY_LIMIT + 1,
      error: "down",
    });
  });

  it("fails a step at once on a failure that is not retriable", () => {
    const tooLarge = { error: "too large", retriable: false };
    expect(countStepFailure(undefined, tooLarge)).toEqual({
      status: "failed",
      failures: 1,
      error: "too large",
    });
    expect(
      countStepFailure(
        { status: "failing", failures: 2, error: "down" },
        tooLarge
      )
    ).toEqual({ status: "failed", failures: 3, error: "too large" });
  });

  it("leaves a row that already succeeded or failed alone", () => {
    const down = { error: "down", retriable: true };
    expect(
      countStepFailure({ status: "succeeded", failures: 2, value: 1 }, down)
    ).toBeNull();
    expect(
      countStepFailure({ status: "failed", failures: 5, error: "x" }, down)
    ).toBeNull();
  });
});

describe("retriesSpent", () => {
  it("spends a schedule row's own retries past the same limit a step has", () => {
    expect(retriesSpent(STEP_RETRY_LIMIT)).toBe(false);
    expect(retriesSpent(STEP_RETRY_LIMIT + 1)).toBe(true);
  });
});

describe("sweptStepFailures", () => {
  it("counts an expired lease against the step its row recorded, and nothing for a row that was not leased", () => {
    expect(
      sweptStepFailures([
        {
          id: "sched_1",
          state: "leased",
          runningStepId: "step_a",
          runningNodeId: "node_a",
        },
        {
          id: "sched_2",
          state: "leased",
          runningStepId: null,
          runningNodeId: null,
        },
        {
          id: "sched_3",
          state: "queued",
          runningStepId: null,
          runningNodeId: null,
        },
      ])
    ).toEqual([
      {
        scheduleId: "sched_1",
        stepId: "step_a",
        nodeId: "node_a",
        error: LEASE_EXPIRED_ERROR,
        retriable: true,
      },
    ]);
  });
});

describe("stepFailureOf", () => {
  it("counts a thrown step and a budget cut's running step, and nothing for a drain or a cut between steps", () => {
    expect(
      stepFailureOf({
        kind: "step_failed",
        nodeId: "node_a",
        stepId: "step_a",
        error: "down",
        backoffMs: 1_000,
      })
    ).toEqual({
      stepId: "step_a",
      nodeId: "node_a",
      error: "down",
      retriable: true,
    });
    expect(
      stepFailureOf({
        kind: "step_failed",
        nodeId: "node_a",
        stepId: "step_a",
        error: "too large",
        backoffMs: 1_000,
        retriable: false,
      })
    ).toMatchObject({ retriable: false });
    expect(
      stepFailureOf({
        kind: "interrupted",
        by: "budget",
        nodeId: null,
        stepId: "step_a",
        wakeAfterMs: 0,
      })
    ).toEqual({
      stepId: "step_a",
      nodeId: null,
      error: BUDGET_CUT_ERROR,
      retriable: true,
    });
    expect(
      stepFailureOf({
        kind: "interrupted",
        by: "budget",
        nodeId: null,
        stepId: null,
        wakeAfterMs: 0,
      })
    ).toBeNull();
    expect(
      stepFailureOf({ kind: "interrupted", by: "drain", wakeAfterMs: 0 })
    ).toBeNull();
  });
});

describe("decideRelease", () => {
  const failing = { status: "failing", failures: 1, error: "down" } as const;

  it("waits out a failing step's backoff, and re-queues a failed step at once", () => {
    const outcome = {
      kind: "step_failed",
      nodeId: null,
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

  it("counts a failure no step owns against the schedule row", () => {
    expect(
      decideRelease({
        outcome: { kind: "body_failed", error: "boom", backoffMs: 1_000 },
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
  });

  it("re-queues a run whose version fence was refused after its backoff, counting nothing and keeping the row's count", () => {
    expect(
      decideRelease({
        outcome: { kind: "fence_refused", backoffMs: 1_000 },
        attempt: 2,
        now: NOW,
        parks: [],
        countedStep: null,
      })
    ).toEqual({
      state: "queued",
      wakeAt: after(1_000),
      attempt: 2,
      lastError: null,
    });
  });

  it("re-queues an interrupted pass after its wakeAfterMs, keeping the row's count, and records a budget cut's counted step", () => {
    expect(
      decideRelease({
        outcome: { kind: "interrupted", by: "drain", wakeAfterMs: 0 },
        attempt: 2,
        now: NOW,
        parks: [],
        countedStep: null,
      })
    ).toEqual({ state: "queued", wakeAt: NOW, attempt: 2, lastError: null });
    expect(
      decideRelease({
        outcome: {
          kind: "interrupted",
          by: "budget",
          nodeId: null,
          stepId: "step_a",
          wakeAfterMs: 60_000,
        },
        attempt: 2,
        now: NOW,
        parks: [],
        countedStep: {
          status: "failing",
          failures: 1,
          error: BUDGET_CUT_ERROR,
        },
      })
    ).toEqual({
      state: "queued",
      wakeAt: new Date(NOW.getTime() + 60_000),
      attempt: 2,
      lastError: BUDGET_CUT_ERROR,
    });
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
