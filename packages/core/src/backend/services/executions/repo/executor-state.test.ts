import { describe, expect, it } from "vitest";
import {
  type ActivityRow,
  type ExecutorHold,
  executorActivities,
  executorActivityOf,
} from "#src/backend/services/executions/repo/executor-state";
import type { UnconsumedWake } from "#src/backend/services/executions/repo/contracts";

const NOW = new Date("2026-03-01T09:00:00.000Z");

function after(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

function hold(fields: Partial<ExecutorHold>): ExecutorHold {
  return {
    state: "queued",
    wakeAt: after(30_000),
    attempt: 0,
    leaseExpiresAt: null,
    workerId: null,
    runningNodeId: null,
    runningNodeName: null,
    lastError: null,
    failingSteps: [],
    unconsumedWakes: [],
    ...fields,
  };
}

const APPROVED: UnconsumedWake = {
  waitStateId: "wait_1",
  nodeId: "approval",
  nodeName: "Wait for approval",
  kind: "resume",
  eventName: "app/approved",
  wokenAt: after(-90_000),
  deadline: after(600_000),
};

const LEASED = {
  state: "leased",
  workerId: "worker_1",
  runningNodeId: "send",
  runningNodeName: "Send reminder",
} as const;

describe("executorActivityOf", () => {
  it("answers an unconsumed wake as resuming before anything else, waiting for a worker only while no lease is held", () => {
    expect(
      executorActivityOf(
        hold({
          wakeAt: after(-90_000),
          failingSteps: [
            { nodeId: "send", nodeName: null, failures: 1, error: "down" },
          ],
          unconsumedWakes: [
            APPROVED,
            { ...APPROVED, waitStateId: "wait_2", nodeId: "later" },
          ],
        }),
        NOW
      )
    ).toEqual({
      kind: "resuming",
      nodeId: "approval",
      nodeName: "Wait for approval",
      wake: "resume",
      eventName: "app/approved",
      wokenAt: after(-90_000),
      deadline: after(600_000),
      unclaimedSince: after(-90_000),
    });
    // A wake that records no time has waited since the row was made due.
    expect(
      executorActivityOf(
        hold({
          wakeAt: after(-5_000),
          unconsumedWakes: [
            { ...APPROVED, kind: "cancel", eventName: null, wokenAt: null },
          ],
        }),
        NOW
      )
    ).toMatchObject({ kind: "resuming", unclaimedSince: after(-5_000) });
    expect(
      executorActivityOf(
        hold({
          ...LEASED,
          leaseExpiresAt: after(-1),
          unconsumedWakes: [APPROVED],
        }),
        NOW
      )
    ).toMatchObject({ kind: "resuming", unclaimedSince: null });
  });

  it("answers a lease that ended at or before now as expired, and a lease still held as running", () => {
    expect(
      executorActivityOf(hold({ ...LEASED, leaseExpiresAt: NOW }), NOW)
    ).toEqual({
      kind: "lease_expired",
      nodeId: "send",
      nodeName: "Send reminder",
      since: NOW,
    });
    expect(
      executorActivityOf(hold({ ...LEASED, leaseExpiresAt: after(1) }), NOW)
    ).toEqual({
      kind: "running",
      nodeId: "send",
      nodeName: "Send reminder",
      workerId: "worker_1",
    });
  });

  it("names the step with the most failures, then the run body's own, and nothing for a queued row with no failure", () => {
    expect(
      executorActivityOf(
        hold({
          lastError: "the body failed",
          failingSteps: [
            { nodeId: "notify", nodeName: null, failures: 1, error: "busy" },
            {
              nodeId: "send",
              nodeName: "Send reminder",
              failures: 3,
              error: "send is down",
            },
          ],
        }),
        NOW
      )
    ).toEqual({
      kind: "retrying",
      nodeId: "send",
      nodeName: "Send reminder",
      nextTryAt: after(30_000),
      failures: 3,
      error: "send is down",
    });
    expect(
      executorActivityOf(
        hold({ attempt: 2, lastError: "the body failed" }),
        NOW
      )
    ).toEqual({
      kind: "retrying",
      nodeId: null,
      nodeName: null,
      nextTryAt: after(30_000),
      failures: 2,
      error: "the body failed",
    });
    expect(executorActivityOf(hold({}), NOW)).toBeNull();
  });

  it("answers a due row that is queued or asleep on its parks as unclaimed, and a row asleep and not due as waiting", () => {
    expect(executorActivityOf(hold({ wakeAt: NOW }), NOW)).toEqual({
      kind: "unclaimed",
      dueSince: NOW,
    });
    expect(
      executorActivityOf(hold({ state: "waiting", wakeAt: after(-5) }), NOW)
    ).toEqual({ kind: "unclaimed", dueSince: after(-5) });
    expect(executorActivityOf(hold({ state: "waiting" }), NOW)).toEqual({
      kind: "waiting",
    });
  });
});

describe("executorActivities", () => {
  it("decides each run once from all of its failing step rows, and leaves out a run with no activity", () => {
    const row = (fields: Partial<ActivityRow>): ActivityRow => ({
      ...hold({}),
      executionId: "exec_1",
      failing: null,
      ...fields,
    });
    expect(
      executorActivities(
        [
          row({
            failing: { nodeId: "a", nodeName: "A", failures: 1, error: "a" },
          }),
          row({
            failing: { nodeId: "b", nodeName: "B", failures: 2, error: "b" },
          }),
          row({ executionId: "exec_2" }),
        ],
        NOW
      )
    ).toEqual(
      new Map([
        [
          "exec_1",
          {
            kind: "retrying",
            nodeId: "b",
            nodeName: "B",
            nextTryAt: after(30_000),
            failures: 2,
            error: "b",
          },
        ],
      ])
    );
  });
});
