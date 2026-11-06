import { describe, expect, it } from "vitest";
import {
  executorActivityOf,
  executorHolds,
} from "#src/backend/services/executions/repo/executor-activity";
import { stubExecutorHold } from "#src/backend/lib/effect/test-layers";
import type {
  ExecutionSchedule,
  ExecutorHold,
  UnconsumedWake,
} from "#src/backend/services/executions/repo/contracts";

const NOW = new Date("2026-03-01T09:00:00.000Z");

function after(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

/** The activity of a run queued 30 seconds ahead, with `fields` over it. */
function activityOf(
  fields: Partial<ExecutorHold>,
  wakes: readonly UnconsumedWake[] = []
) {
  return executorActivityOf({
    hold: stubExecutorHold({ wakeAt: after(30_000), ...fields }),
    wakes,
    now: NOW,
  });
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
  runningStepId: "node:send:dispatch",
  runningNodeId: "send",
  runningNodeName: "Send reminder",
} as const;

describe("executorActivityOf", () => {
  it("answers an unconsumed wake as resuming before a failing step, waiting for a worker only while no live lease holds the run", () => {
    expect(
      activityOf(
        {
          wakeAt: after(-90_000),
          failingSteps: [
            {
              stepId: "node:send:dispatch",
              nodeId: "send",
              nodeName: null,
              failures: 1,
              error: "down",
            },
          ],
        },
        [APPROVED, { ...APPROVED, waitStateId: "wait_2", nodeId: "later" }]
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
      activityOf({ wakeAt: after(-5_000) }, [
        { ...APPROVED, kind: "cancel", eventName: null, wokenAt: null },
      ])
    ).toMatchObject({ kind: "resuming", unclaimedSince: after(-5_000) });
    expect(
      activityOf({ ...LEASED, leaseExpiresAt: after(1) }, [APPROVED])
    ).toMatchObject({ kind: "resuming", unclaimedSince: null });
  });

  it("answers a lease that ended at or before now as expired, and a lease still held as running", () => {
    expect(activityOf({ ...LEASED, leaseExpiresAt: NOW })).toEqual({
      kind: "lease_expired",
      nodeId: "send",
      nodeName: "Send reminder",
      since: NOW,
    });
    expect(activityOf({ ...LEASED, leaseExpiresAt: after(1) })).toEqual({
      kind: "running",
      nodeId: "send",
      nodeName: "Send reminder",
      workerId: "worker_1",
    });
  });

  // A worker that dies after a producer wrote a wake leaves both on the run.
  // Nothing acts on the wake until another worker claims the run, so the
  // expired lease is what the overview says.
  it("answers an expired lease before an unconsumed wake", () => {
    expect(
      activityOf({ ...LEASED, leaseExpiresAt: after(-1) }, [APPROVED])
    ).toEqual({
      kind: "lease_expired",
      nodeId: "send",
      nodeName: "Send reminder",
      since: after(-1),
    });
  });

  it("names the step with the most failures, then the run body's own, and nothing for a queued row with no failure", () => {
    expect(
      activityOf({
        lastError: "the body failed",
        failingSteps: [
          {
            stepId: "node:notify:dispatch",
            nodeId: "notify",
            nodeName: null,
            failures: 1,
            error: "busy",
          },
          {
            stepId: "node:send:dispatch",
            nodeId: "send",
            nodeName: "Send reminder",
            failures: 3,
            error: "send is down",
          },
        ],
      })
    ).toEqual({
      kind: "retrying",
      nodeId: "send",
      nodeName: "Send reminder",
      nextTryAt: after(30_000),
      failures: 3,
      error: "send is down",
    });
    expect(activityOf({ attempt: 2, lastError: "the body failed" })).toEqual({
      kind: "retrying",
      nodeId: null,
      nodeName: null,
      nextTryAt: after(30_000),
      failures: 2,
      error: "the body failed",
    });
    expect(activityOf({})).toBeNull();
  });

  it("answers a due row that is queued or asleep on its parks as unclaimed, and a row asleep and not due as waiting", () => {
    expect(activityOf({ wakeAt: NOW })).toEqual({
      kind: "unclaimed",
      dueSince: NOW,
    });
    expect(activityOf({ state: "waiting", wakeAt: after(-5) })).toEqual({
      kind: "unclaimed",
      dueSince: after(-5),
    });
    expect(activityOf({ state: "waiting" })).toEqual({ kind: "waiting" });
  });
});

describe("executorHolds", () => {
  const schedule = (
    id: string,
    executionId: string | null
  ): ExecutionSchedule => ({
    id,
    kind: executionId === null ? "delivery" : "run",
    executionId,
    inboxId: executionId === null ? "inbox_1" : null,
    state: "queued",
    wakeAt: NOW,
    attempt: 0,
    runningStepId: null,
    runningNodeId: null,
    leaseExpiresAt: null,
    ownerToken: null,
    workerId: null,
    lastError: null,
  });

  it("gives each run its own failing steps, most failures first, and leaves out a delivery's row", () => {
    const failing = (scheduleId: string, nodeId: string, failures: number) => ({
      scheduleId,
      stepId: `node:${nodeId}:dispatch`,
      nodeId,
      nodeName: nodeId.toUpperCase(),
      failures,
      error: `${nodeId} failed`,
    });
    const holds = executorHolds(
      [
        { schedule: schedule("sched_1", "exec_1"), runningNodeName: null },
        { schedule: schedule("sched_2", "exec_2"), runningNodeName: null },
        { schedule: schedule("sched_3", null), runningNodeName: null },
      ],
      [
        failing("sched_1", "a", 1),
        failing("sched_1", "b", 2),
        failing("sched_3", "c", 1),
      ]
    );
    expect([...holds.keys()]).toEqual(["exec_1", "exec_2"]);
    expect(
      holds.get("exec_1")?.failingSteps.map((step) => step.nodeId)
    ).toEqual(["b", "a"]);
    expect(holds.get("exec_2")?.failingSteps).toEqual([]);
  });

  it("refuses a failing memo row that holds no error", () => {
    expect(() =>
      executorHolds(
        [{ schedule: schedule("sched_1", "exec_1"), runningNodeName: null }],
        [
          {
            scheduleId: "sched_1",
            stepId: "node:a:dispatch",
            nodeId: "a",
            nodeName: null,
            failures: 1,
            error: null,
          },
        ]
      )
    ).toThrow("A failing step memo row holds no error");
  });
});
