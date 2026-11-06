import { describe, expect, it } from "vitest";
import {
  type ExecutorSchedule,
  executorActivityCopy,
  executorDetails,
  type NodeNamer,
  type ScheduleActivity,
  serverNowMs,
  shortDuration,
  UNCLAIMED_WARNING_MS,
} from "#src/lib/run-executor-activity";

/** An instant at a local clock reading, so the expected text is the same in every timezone. */
function localAt(hours: number, minutes: number, seconds: number): string {
  return new Date(2026, 2, 1, hours, minutes, seconds).toISOString();
}

const NOW_MS = Date.parse(localAt(14, 40, 0));

/** The executor's own name for a node, and otherwise the node id. */
const nameOf: NodeNamer = ({ nodeId, nodeName }) => nodeName ?? nodeId;

function copyOf(activity: ScheduleActivity, nowMs = NOW_MS) {
  return executorActivityCopy({ activity, nameOf, nowMs });
}

describe("executorActivityCopy", () => {
  it("names the node a worker is running, or says it is between steps", () => {
    expect(
      copyOf({
        kind: "running",
        nodeId: "send",
        nodeName: "Send reminder",
        workerId: "worker-a1",
      })
    ).toEqual({
      headline: "Running “Send reminder” on worker-a1",
      detail: null,
      tone: "default",
    });
    expect(
      copyOf({
        kind: "running",
        nodeId: null,
        nodeName: null,
        workerId: "worker-a1",
      })?.headline
    ).toBe("Running on worker-a1, between steps");
  });

  it("says when a worker stopped renewing its lease and what happens next", () => {
    expect(
      copyOf({
        kind: "lease_expired",
        nodeId: "send",
        nodeName: null,
        since: localAt(14, 32, 5),
      })
    ).toEqual({
      headline:
        "The worker running “send” stopped renewing its lease at 14:32:05.",
      detail:
        "The next worker to claim the run will count a failure against the step and try it again.",
      tone: "default",
    });
  });

  it("counts a step's tries and a run's tries, with the last error beneath", () => {
    expect(
      copyOf({
        kind: "retrying",
        nodeId: "send",
        nodeName: "Send reminder",
        nextTryAt: localAt(14, 41, 30),
        failures: 2,
        retryLimit: 4,
        error: "Twilio answered 503",
      })
    ).toEqual({
      headline: "Retrying “Send reminder” at 14:41:30, try 3 of 5",
      detail: "Twilio answered 503",
      tone: "default",
    });
    expect(
      copyOf({
        kind: "retrying",
        nodeId: null,
        nodeName: null,
        nextTryAt: localAt(14, 41, 30),
        failures: 1,
        retryLimit: 4,
        error: null,
      })
    ).toEqual({
      headline: "Retrying the run at 14:41:30, try 2 of 5",
      detail: null,
      tone: "default",
    });
  });

  it("warns about an unclaimed run from 60 seconds past due", () => {
    const dueSince = localAt(14, 39, 0);
    const justUnder = copyOf(
      { kind: "unclaimed", dueSince },
      Date.parse(dueSince) + UNCLAIMED_WARNING_MS - 1
    );
    expect(justUnder).toEqual({
      headline: "Queued for a worker since 14:39:00",
      detail: null,
      tone: "default",
    });
    const atThreshold = copyOf(
      { kind: "unclaimed", dueSince },
      Date.parse(dueSince) + UNCLAIMED_WARNING_MS
    );
    expect(atThreshold).toEqual({
      headline:
        "Queued since 14:39:00. No worker has claimed this run for 1 min.",
      detail:
        "Runs are claimed by the worker loop of createWfGraphApp or createWfGraphRunner, or by the Worker's Cron Trigger. Check that one of them is running against this database.",
      tone: "warning",
    });
  });

  it("names what woke a parked run", () => {
    const resuming = {
      kind: "resuming",
      nodeId: "approval",
      nodeName: "Wait for approval",
      eventName: null,
      wokenAt: null,
      deadline: null,
      unclaimedSince: null,
    } as const;
    expect(
      copyOf({
        ...resuming,
        wake: "resume",
        eventName: "app/approved",
        wokenAt: localAt(14, 39, 50),
      })?.headline
    ).toBe("Resuming: app/approved arrived at 14:39:50");
    expect(
      copyOf({ ...resuming, wake: "resume", wokenAt: localAt(14, 39, 50) })
        ?.headline
    ).toBe("Resuming: resumed at 14:39:50");
    expect(
      copyOf({ ...resuming, wake: "timeout", deadline: localAt(14, 39, 0) })
        ?.headline
    ).toBe("Resuming: the wait's deadline passed at 14:39:00");
    expect(copyOf({ ...resuming, wake: "cancel" })?.headline).toBe(
      "Canceling: a Cancel Event claimed this run"
    );
    expect(copyOf({ ...resuming, wake: "exit" })?.headline).toBe(
      "Exiting: Entity eligibility no longer passes"
    );
    expect(copyOf({ ...resuming, wake: "migrate" })?.headline).toBe(
      "Moving to the new version"
    );
  });

  it("adds that a woken run waits for a worker from 60 seconds after the wake", () => {
    const wokenAt = localAt(14, 39, 0);
    const resuming: ScheduleActivity = {
      kind: "resuming",
      nodeId: "approval",
      nodeName: "Wait for approval",
      wake: "cancel",
      eventName: null,
      wokenAt,
      deadline: null,
      unclaimedSince: wokenAt,
    };
    expect(
      copyOf(resuming, Date.parse(wokenAt) + UNCLAIMED_WARNING_MS - 1)?.headline
    ).toBe("Canceling: a Cancel Event claimed this run");
    expect(
      copyOf(resuming, Date.parse(wokenAt) + UNCLAIMED_WARNING_MS)?.headline
    ).toBe("Canceling: a Cancel Event claimed this run, waiting for a worker");
    // A worker holds the run, so it is not waiting for one however old the wake.
    expect(
      copyOf({ ...resuming, unclaimedSince: null }, NOW_MS + 3_600_000)
        ?.headline
    ).toBe("Canceling: a Cancel Event claimed this run");
  });

  it("says nothing for a run asleep on its parks", () => {
    expect(copyOf({ kind: "waiting" })).toBeNull();
  });
});

describe("executorDetails", () => {
  const schedule: ExecutorSchedule = {
    observedAt: localAt(14, 40, 0),
    activity: null,
    state: "queued",
    wakeAt: localAt(14, 41, 30),
    attempt: 0,
    retryLimit: 4,
    runningStepId: null,
    runningNodeId: null,
    runningNodeName: null,
    leaseExpiresAt: null,
    workerId: null,
    lastError: null,
    failingSteps: [],
    unconsumedWakes: [],
  };

  it("shows a queued run's due time and leaves out the facts it lacks", () => {
    expect(executorDetails({ schedule, nowMs: NOW_MS })).toEqual([
      { term: "Schedule", value: "Queued, due 14:41:30", mono: false },
      { term: "Run failures", value: "0 of 4", mono: false },
    ]);
  });

  it("shows a leased run's lease, worker and running step", () => {
    const leased: ExecutorSchedule = {
      ...schedule,
      state: "leased",
      attempt: 1,
      leaseExpiresAt: localAt(14, 40, 22),
      workerId: "worker-a1",
      runningStepId: "node:send:dispatch",
    };
    expect(executorDetails({ schedule: leased, nowMs: NOW_MS })).toEqual([
      { term: "Schedule", value: "Leased", mono: false },
      { term: "Run failures", value: "1 of 4", mono: false },
      { term: "Lease expires", value: "14:40:22 (in 22 s)", mono: false },
      { term: "Worker", value: "worker-a1", mono: false },
      { term: "Running step", value: "node:send:dispatch", mono: true },
    ]);
    expect(
      executorDetails({ schedule: leased, nowMs: NOW_MS + 44_000 })[2]
    ).toEqual({
      term: "Lease expires",
      value: "14:40:22 (22 s ago)",
      mono: false,
    });
  });
});

describe("serverNowMs", () => {
  it("adds the time since the answer arrived to the server's clock", () => {
    expect(
      serverNowMs({
        observedAt: "2026-03-01T10:00:00.000Z",
        receivedAtMs: 5_000,
        nowMs: 7_500,
      })
    ).toBe(Date.parse("2026-03-01T10:00:02.500Z"));
    // A browser clock read before the answer arrived adds nothing.
    expect(
      serverNowMs({
        observedAt: "2026-03-01T10:00:00.000Z",
        receivedAtMs: 5_000,
        nowMs: 4_000,
      })
    ).toBe(Date.parse("2026-03-01T10:00:00.000Z"));
  });
});

describe("shortDuration", () => {
  it("keeps to the largest units that fit", () => {
    expect(shortDuration(-1)).toBe("0 s");
    expect(shortDuration(59_999)).toBe("59 s");
    expect(shortDuration(60_000)).toBe("1 min");
    expect(shortDuration(3_600_000)).toBe("1 h");
    expect(shortDuration(3_900_000)).toBe("1 h 5 min");
    expect(shortDuration(90_000_000)).toBe("1 d 1 h");
  });
});
