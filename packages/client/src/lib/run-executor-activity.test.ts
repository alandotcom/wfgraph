import { describe, expect, it } from "vitest";
import {
  type ExecutorSchedule,
  executorActivityCopy,
  executorDetails,
  finishedRetriesSummary,
  listActivityLabel,
  type NodeNamer,
  nodeRetrySummary,
  type ScheduleActivity,
  serverNowMs,
  shortDuration,
} from "#src/lib/run-executor-activity";

/** The server's `overdueAfterMs` for a host running a worker loop at its default poll. */
const OVERDUE_MS = 60_000;

/** An instant at a local clock reading, so the expected text is the same in every timezone. */
function localAt(hours: number, minutes: number, seconds: number): string {
  return new Date(2026, 2, 1, hours, minutes, seconds).toISOString();
}

const NOW_MS = Date.parse(localAt(14, 40, 0));

/** The executor's own name for a node, and otherwise the node id. */
const nameOf: NodeNamer = ({ nodeId, nodeName }) => nodeName ?? nodeId;

function copyOf(
  activity: ScheduleActivity,
  nowMs = NOW_MS,
  overdueAfterMs = OVERDUE_MS
) {
  return executorActivityCopy({ activity, nameOf, nowMs, overdueAfterMs });
}

describe("executorActivityCopy", () => {
  // The node is the one the worker's last lease renewal recorded, so a run
  // just claimed names none yet.
  it("names the node a worker is running, or only the worker", () => {
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
    ).toBe("Running on worker-a1");
  });

  it("says when a worker stopped renewing its lease and what happens next", () => {
    const stalled = {
      kind: "lease_expired",
      nodeId: "send",
      nodeName: null,
      since: localAt(14, 32, 5),
    } as const;
    expect(copyOf(stalled)).toEqual({
      headline:
        "Stalled at “send”: its worker stopped renewing the lease at 14:32:05",
      detail:
        "The next worker to claim the run will count a failure against the step and try it again.",
      tone: "default",
    });
    // Between steps there is no step to count a failure against.
    expect(copyOf({ ...stalled, nodeId: null })).toEqual({
      headline:
        "Stalled between steps: the worker stopped renewing the lease at 14:32:05",
      detail: null,
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
      Date.parse(dueSince) + OVERDUE_MS - 1
    );
    expect(justUnder).toEqual({
      headline: "Queued for a worker since 14:39:00",
      detail: null,
      tone: "default",
    });
    const atThreshold = copyOf(
      { kind: "unclaimed", dueSince },
      Date.parse(dueSince) + OVERDUE_MS
    );
    expect(atThreshold).toEqual({
      headline:
        "Unclaimed for 1 min: no worker has picked up this run since 14:39:00",
      detail:
        "Runs are claimed by the worker loop of createWfGraphApp or createWfGraphRunner, or by the Worker's Cron Trigger. Check that one of them is running against this database.",
      tone: "warning",
    });
  });

  // A Worker host's Cron Trigger looks for due runs once a minute, so its
  // server sends a longer threshold, and the copy waits for it.
  it("warns about an unclaimed run only once the server's threshold has passed", () => {
    const dueSince = localAt(14, 39, 0);
    const at = (waitedMs: number) =>
      copyOf(
        { kind: "unclaimed", dueSince },
        Date.parse(dueSince) + waitedMs,
        120_000
      );
    expect(at(90_000)?.tone).toBe("default");
    expect(at(120_000)?.tone).toBe("warning");
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
    ).toBe("Resuming: resume requested at 14:39:50");
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
      "Migrating to the new version"
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
      copyOf(resuming, Date.parse(wokenAt) + OVERDUE_MS - 1)?.headline
    ).toBe("Canceling: a Cancel Event claimed this run");
    expect(copyOf(resuming, Date.parse(wokenAt) + OVERDUE_MS)?.headline).toBe(
      "Canceling: a Cancel Event claimed this run, waiting for a worker"
    );
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
    overdueAfterMs: OVERDUE_MS,
    activity: null,
    state: "queued",
    wakeAt: localAt(14, 41, 30),
    attempt: 0,
    retryLimit: 4,
    runningStepId: null,
    leaseExpiresAt: null,
    workerId: null,
    failingSteps: [],
  };

  it("shows a queued run's due time and leaves out the facts it lacks", () => {
    expect(executorDetails({ schedule, nowMs: NOW_MS })).toEqual([
      { term: "Schedule", value: "Queued, due 14:41:30", mono: false },
      { term: "Run tries", value: "1 of 5", mono: false },
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
      { term: "Run tries", value: "2 of 5", mono: false },
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

describe("listActivityLabel", () => {
  const dueSince = "2026-03-01T10:00:00.000Z";
  const label = (
    activity: Parameters<typeof listActivityLabel>[0]["activity"]
  ) => listActivityLabel({ activity, receivedAtMs: 0, nowMs: 0 });

  it("names the retried node, or the run when there is none", () => {
    const retrying = {
      kind: "retrying",
      nodeId: "send",
      nodeName: "Send reminder",
      nextTryAt: "2026-03-01T10:01:00.000Z",
      failures: 1,
      retryLimit: 4,
      error: null,
      observedAt: dueSince,
      overdueAfterMs: OVERDUE_MS,
    } as const;
    expect(label(retrying)).toEqual({
      text: "Retrying Send reminder",
      warns: false,
    });
    expect(label({ ...retrying, nodeId: null, nodeName: null })?.text).toBe(
      "Retrying the run"
    );
  });

  it("names the node a stopped worker was running", () => {
    const stopped = {
      kind: "lease_expired",
      nodeId: "send",
      nodeName: null,
      since: dueSince,
      observedAt: dueSince,
      overdueAfterMs: OVERDUE_MS,
    } as const;
    expect(label(stopped)?.text).toBe("Stalled at send");
    expect(label({ ...stopped, nodeId: null })?.text).toBe(
      "Stalled between steps"
    );
  });

  // The wait is measured on the server's clock: the row's own `observedAt`
  // plus the time since its page arrived.
  it("says an unclaimed run waits only once the server's threshold has passed", () => {
    const unclaimed = (observedAt: string, overdueAfterMs = OVERDUE_MS) =>
      ({ kind: "unclaimed", dueSince, observedAt, overdueAfterMs }) as const;
    const at = (
      activity: ReturnType<typeof unclaimed>,
      sinceArrivalMs: number
    ) =>
      listActivityLabel({
        activity,
        receivedAtMs: 1_000,
        nowMs: 1_000 + sinceArrivalMs,
      });

    expect(at(unclaimed("2026-03-01T10:00:50.000Z"), 9_999)).toBeNull();
    expect(at(unclaimed("2026-03-01T10:00:50.000Z"), 10_000)).toEqual({
      text: "Unclaimed for 1 min",
      warns: true,
    });
    // A row from an older page keeps its own reading.
    expect(at(unclaimed("2026-03-01T10:02:00.000Z"), 0)?.text).toBe(
      "Unclaimed for 2 min"
    );
    expect(at(unclaimed(dueSince, 120_000), 90_000)).toBeNull();
    expect(label(null)).toBeNull();
  });

  // Placeholder rows report no arrival time, and a wait measured from none
  // would read as decades.
  it("says nothing about an unclaimed run whose page has no arrival time", () => {
    expect(
      listActivityLabel({
        activity: {
          kind: "unclaimed",
          dueSince,
          observedAt: "2026-03-01T10:05:00.000Z",
          overdueAfterMs: OVERDUE_MS,
        },
        receivedAtMs: null,
        nowMs: Date.now(),
      })
    ).toBeNull();
  });
});

describe("nodeRetrySummary", () => {
  it("says when the step runs next and which try that is, then its failures", () => {
    expect(
      nodeRetrySummary({
        failures: 2,
        retryLimit: 4,
        nextTryAt: localAt(14, 41, 30),
      })
    ).toBe("Retrying at 14:41:30, try 3 of 5. Failed 2 times.");
    expect(
      nodeRetrySummary({ failures: 1, retryLimit: 4, nextTryAt: null })
    ).toBe("Failed 1 time.");
  });
});

describe("finishedRetriesSummary", () => {
  it("says which try a finished execution ended on", () => {
    expect(
      finishedRetriesSummary({ status: "success", retries: 1, retryLimit: 4 })
    ).toBe("Succeeded on try 2");
    expect(
      finishedRetriesSummary({ status: "success", retries: 3, retryLimit: 4 })
    ).toBe("Succeeded on try 4");
    expect(
      finishedRetriesSummary({ status: "error", retries: 4, retryLimit: 4 })
    ).toBe("Failed on try 5 of 5");
    expect(
      finishedRetriesSummary({ status: "success", retries: 0, retryLimit: 4 })
    ).toBeNull();
    expect(
      finishedRetriesSummary({ status: "cancelled", retries: 2, retryLimit: 4 })
    ).toBeNull();
  });
});
