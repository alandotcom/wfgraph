/** Delay-mode Wait coverage through the engine's runtime and store ports. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRecordingWorkflowStore,
  type RecordingWorkflowStore,
} from "#src/backend/engine/recording-store";
import {
  claimedRun,
  expectHaltedByClaim,
  runWait,
  waitOutput,
  waitResumeSignal,
  waitStepLogs,
} from "#src/backend/engine/testing/wait-fixtures";

describe("wait node - delay mode", () => {
  let store: RecordingWorkflowStore;

  beforeEach(() => {
    store = createRecordingWorkflowStore();
  });

  it("parks the run, sleeps, then resumes and closes its own step log", async () => {
    const { runtime, execution } = runWait({
      config: { waitMode: "delay", waitDuration: "1h" },
      store,
    });
    const result = await execution;

    expect(result.success).toBe(true);
    const waitData = waitOutput(result);
    expect(waitData.waitType).toBe("delay");
    // Timestamps cross a step boundary, so they travel as ISO strings.
    expect(Date.parse(waitData.waitUntil as string)).toBeGreaterThan(
      Date.now()
    );

    const created = store.callsOf("createWaitState");
    expect(created).toHaveLength(1);
    expect(created[0]?.waitType).toBe("delay");
    expect(created[0]?.nodeId).toBe("wait_1");
    expect(created[0]?.executionId).toBe("exec_wait");

    // The park is a signal wait whose timeout is what is left of the delay:
    // roughly an hour, allowing for the milliseconds the run itself took.
    const park = runtime.waits.find(
      (wait) => wait.stepId === "wait-park-wait_1-0"
    );
    expect(park?.options.timeoutMs).toBeGreaterThan(3_500_000);
    // A delay wait answers to a Migration and to nothing else.
    expect(park?.options.ifExpression).toContain(
      'async.data.signalType == "version-migrate"'
    );
    expect(park?.options.ifExpression).not.toContain("wait-resume");

    // One park, so the row is written once and never re-parked.
    expect(store.callsOf("reparkWaitState")).toHaveLength(0);
    expect(waitData.hops).toBe(1);
    expect(store.callsOf("markWaitStateStatus")).toEqual([
      { waitStateId: "wait_state_1", status: "resumed" },
    ]);
    expect(store.callsOf("markExecutionRunning")).toEqual([
      {
        executionId: "exec_wait",
        workflowVersionId: "ver_test",
        side: "started",
      },
    ]);

    const auditTypes = store
      .callsOf("recordAuditEvent")
      .map((c) => c.eventType);
    expect(auditTypes).toEqual(["run_waiting", "run_resumed", "run_completed"]);

    const stepLogs = waitStepLogs(store);
    expect(stepLogs.opened).toHaveLength(1);
    expect(stepLogs.closed).toEqual([
      expect.objectContaining({ status: "success" }),
    ]);
  });

  it("normalizes timezone whitespace before applying allowed hours", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "delay",
        waitDuration: "1h",
        waitGateMode: "require_actual_wait",
        waitAllowedHoursMode: "daily_window",
        waitAllowedStartTime: "09:00",
        waitAllowedEndTime: "17:00",
        waitTimezone: " UTC ",
      },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(true);
    expect(runtime.waits).toHaveLength(1);
  });

  it("halts the branch instead of waiting when a gated target has already passed", async () => {
    const { runtime, execution } = runWait({
      config: {
        waitMode: "delay",
        waitDuration: "-1h",
        waitGateMode: "require_actual_wait",
      },
      store,
    });
    const result = await execution;

    expect(result.results.after_wait).toBeUndefined();
    expect(waitOutput(result)).toMatchObject({
      skipped: true,
      skippedReason: "past_due_no_wait",
    });
    // Nothing to wait for means no wait-state row and no park at all.
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(runtime.waits).toHaveLength(0);
    expect(store.callsOf("recordAuditEvent")[0]?.eventType).toBe("run_skipped");
  });

  it("continues when a target is late but within its maximum lateness", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));

    try {
      const { execution } = runWait({
        config: {
          waitMode: "delay",
          waitUntil: "2026-03-10T10:00:00Z",
          waitGateMode: "max_lateness",
          waitMaxLateness: "6h",
        },
        store,
      });
      const result = await execution;

      expect(result.results.after_wait?.success).toBe(true);
      expect(waitOutput(result)).not.toHaveProperty("skipped");
      expect(store.callsOf("createWaitState")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("parks normally when a maximum-lateness target is still in the future", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));

    try {
      const { runtime, execution } = runWait({
        config: {
          waitMode: "delay",
          waitUntil: "2026-03-10T13:00:00Z",
          waitGateMode: "max_lateness",
          waitMaxLateness: "6h",
        },
        store,
      });
      const result = await execution;

      expect(result.results.after_wait?.success).toBe(true);
      expect(waitOutput(result)).not.toHaveProperty("skipped");
      expect(runtime.waits).toHaveLength(1);
      expect(store.callsOf("createWaitState")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continues at the exact maximum-lateness boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-03-10T12:00:00Z");
    vi.setSystemTime(now);
    // A later clock read has advanced, but the gate evaluates against the
    // attempt's captured instant so the exact boundary remains inclusive.
    vi.spyOn(Date, "now").mockReturnValue(now.getTime() + 1);

    try {
      const { execution } = runWait({
        config: {
          waitMode: "delay",
          waitDuration: "-6h",
          waitGateMode: "max_lateness",
          waitMaxLateness: "6h",
        },
        store,
      });
      const result = await execution;

      expect(result.results.after_wait?.success).toBe(true);
      expect(waitOutput(result)).not.toHaveProperty("skipped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks maximum lateness before moving the target into allowed hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T08:00:00Z"));

    try {
      const { runtime, execution } = runWait({
        config: {
          waitMode: "delay",
          waitUntil: "2026-03-10T01:00:00Z",
          waitGateMode: "max_lateness",
          waitMaxLateness: "6h",
          waitAllowedHoursMode: "daily_window",
          waitAllowedStartTime: "09:00",
          waitAllowedEndTime: "17:00",
          waitTimezone: "UTC",
        },
        store,
      });
      const result = await execution;

      expect(result.results.after_wait).toBeUndefined();
      expect(waitOutput(result)).toMatchObject({
        waitUntil: "2026-03-10T01:00:00.000Z",
        waitMaxLateness: "6h",
        skipped: true,
        skippedReason: "past_due_beyond_max_lateness",
      });
      expect(store.callsOf("createWaitState")).toHaveLength(0);
      expect(runtime.waits).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the node when maximum lateness is zero or invalid", async () => {
    const { execution } = runWait({
      config: {
        waitMode: "delay",
        waitDuration: "1h",
        waitGateMode: "max_lateness",
        waitMaxLateness: "0h",
      },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(waitStepLogs(store).closed[0]).toMatchObject({ status: "error" });
  });

  it("fails the node when no target timestamp can be resolved", async () => {
    const { execution } = runWait({
      config: { waitMode: "delay", waitDuration: "not a duration" },
      store,
    });
    const result = await execution;

    expect(result.results.wait_1?.success).toBe(false);
    expect(store.callsOf("createWaitState")).toHaveLength(0);
    expect(waitStepLogs(store).closed[0]).toMatchObject({ status: "error" });
  });

  // A delay park answers an Exit claimed by another branch of the run. The wake
  // halts the branch, closes the row as cancelled, and skips the running write,
  // which a claimed run refuses.
  it("halts the branch and closes the wait as cancelled when an Exit wakes it", async () => {
    const { runtime, execution } = runWait({
      config: { waitMode: "delay", waitDuration: "1h" },
      store,
      resumeEvent: { data: { signalType: "lifecycle-exit" } },
    });
    const result = await execution;

    expect(result.results.after_wait).toBeUndefined();
    expect(runtime.waits.at(0)?.options.ifExpression).toContain(
      'async.data.signalType == "lifecycle-exit"'
    );
    expect(store.callsOf("markWaitStateStatus")).toEqual([
      { waitStateId: "wait_state_1", status: "cancelled" },
    ]);
    expect(store.callsOf("markExecutionRunning")).toEqual([]);
    expect(
      store
        .callsOf("recordAuditEvent")
        .filter((event) => event.eventType === "run_resumed")
    ).toEqual([
      expect.objectContaining({
        message: "Run woken by an Exit in node 'Wait'",
        metadata: { nodeId: "wait_1", hops: 1 },
      }),
    ]);
    expect(store.callsOf("startStepLog").map((open) => open.nodeId)).toEqual([
      "lifecycle_1",
      "wait_1",
    ]);
  });

  // A branch admitted before a claim can reach its park after the run that won
  // the claim read the parked Waits, so no signal would ever reach it. The park
  // write refuses a Started-side park under either claim, and the Wait then
  // halts its branch where it stands instead of failing its step.
  it.each(["exit", "cancel"] as const)(
    "halts without parking when a %s claim refused the park",
    async (kind) => {
      store.terminationState = claimedRun(kind);

      const { runtime, execution } = runWait({
        config: { waitMode: "delay", waitDuration: "1h" },
        store,
      });
      const result = await execution;

      expect(runtime.waits).toHaveLength(0);
      expect(waitOutput(result)).toEqual({
        waitType: "delay",
        haltedBy: kind,
      });
      expect(result.results.after_wait).toBeUndefined();
      // Nothing parked, so the timeline has no park and no resume to record.
      expect(
        store
          .callsOf("recordAuditEvent")
          .filter(
            (event) =>
              event.eventType === "run_waiting" ||
              event.eventType === "run_resumed"
          )
      ).toEqual([]);
      expect(waitStepLogs(store).closed).toEqual([
        expect.objectContaining({ status: "success" }),
      ]);
    }
  );

  // A resume signal can reach the park after a claim, when its producer took the
  // row before the claim and its signal arrives first. The running write refuses
  // the claimed run, and the Wait halts as the claim's own wake would.
  it.each(["exit", "cancel"] as const)(
    "halts as the %s claim when the running write refuses a resume wake",
    async (kind) => {
      store.markRunningAnswer = false;

      const { execution } = runWait({
        config: { waitMode: "delay", waitDuration: "1h" },
        store,
        resumeEvent: waitResumeSignal({ orderId: "ord_1" }),
        claimOnPark: claimedRun(kind),
      });

      expectHaltedByClaim(store, await execution, kind);
    }
  );

  it("reuses the memoized wait state and step log across a replay", async () => {
    const memo = new Map<string, unknown>();
    const config = { waitMode: "delay", waitDuration: "1h" };

    await runWait({ config, store, memo }).execution;
    await runWait({ config, store, memo }).execution;

    expect(store.callsOf("createWaitState")).toHaveLength(1);
    expect(waitStepLogs(store).opened).toHaveLength(1);
    expect(store.callsOf("completeRun")).toHaveLength(1);
  });
});
