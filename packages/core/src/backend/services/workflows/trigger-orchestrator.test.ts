import { describe, expect, it, vi } from "vitest";
import { orchestrateTriggerExecution } from "./trigger-orchestrator";

function createWaitState(
  id: string,
  executionId: string,
  waitForEvents?: string[]
) {
  return {
    id,
    executionId,
    nodeId: `node_${id}`,
    hookToken: `token_${id}`,
    metadata: waitForEvents ? { waitForEvents } : null,
  };
}

// Every case supplies all four callbacks; each test overrides the ones it
// asserts on, so an unexpected call shows up as a count assertion rather than
// a crash.
function createCallbacks(overrides?: {
  startExecution?: () => Promise<{
    executionId: string;
    runId?: string;
    runMode: "live" | "test";
  }>;
  cancelInFlightRuns?: (eventType?: string) => Promise<{
    cancelledExecutions: number;
    cancelledWaits: number;
    failedExecutions?: string[];
  }>;
  resumeWaitStates?: (
    eventType: string,
    waitStates: Array<{ id: string }>
  ) => Promise<number>;
}) {
  return {
    startExecution: vi.fn(
      overrides?.startExecution ??
        (async () => ({
          executionId: "exec_started",
          runId: "run_started",
          runMode: "live" as const,
        }))
    ),
    cancelInFlightRuns: vi.fn(
      overrides?.cancelInFlightRuns ??
        (async () => ({ cancelledExecutions: 0, cancelledWaits: 0 }))
    ),
    resumeWaitStates: vi.fn(overrides?.resumeWaitStates ?? (async () => 0)),
  };
}

describe("orchestrateTriggerExecution", () => {
  it("ignores an invalid payload without attempting resumes", async () => {
    const callbacks = createCallbacks({ resumeWaitStates: async () => 1 });

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: undefined,
        correlationKey: undefined,
        action: "ignore",
        ignoreReason: "invalid_payload",
      },
      inFlightExecutionIds: [],
      waitStates: [createWaitState("1", "exec_wait_1")],
      enableResumes: true,
      ...callbacks,
    });

    expect(result).toEqual({
      status: "ignored",
      runMode: "live",
      reason: "invalid_payload",
    });
    expect(callbacks.resumeWaitStates).not.toHaveBeenCalled();
    expect(callbacks.startExecution).not.toHaveBeenCalled();
  });

  it("ignores a payload with no event type without attempting resumes", async () => {
    const callbacks = createCallbacks({ resumeWaitStates: async () => 1 });

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: undefined,
        correlationKey: "abc",
        action: "ignore",
        ignoreReason: "missing_event_type",
      },
      inFlightExecutionIds: [],
      waitStates: [createWaitState("1", "exec_wait_1")],
      enableResumes: true,
      ...callbacks,
    });

    expect(result).toEqual({
      status: "ignored",
      runMode: "live",
      reason: "missing_event_type",
    });
    expect(callbacks.resumeWaitStates).not.toHaveBeenCalled();
  });

  it("starts a fresh run when replace finds nothing in flight", async () => {
    const callbacks = createCallbacks();

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: "appointment.rescheduled",
        correlationKey: "abc",
        action: "replace",
      },
      inFlightExecutionIds: [],
      waitStates: [],
      enableResumes: true,
      ...callbacks,
    });

    expect(callbacks.cancelInFlightRuns).not.toHaveBeenCalled();
    expect(callbacks.startExecution).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "running",
      executionId: "exec_started",
      runId: "run_started",
      runMode: "live",
    });
  });

  it("cancels the in-flight runs before starting the replacement", async () => {
    const callOrder: string[] = [];
    const callbacks = createCallbacks({
      startExecution: async () => {
        callOrder.push("start");
        return {
          executionId: "exec_replacement",
          runId: "run_replacement",
          runMode: "test" as const,
        };
      },
      cancelInFlightRuns: async () => {
        callOrder.push("cancel");
        return { cancelledExecutions: 2, cancelledWaits: 3 };
      },
    });

    const result = await orchestrateTriggerExecution({
      runMode: "test",
      routing: {
        eventType: "appointment.rescheduled",
        correlationKey: "abc",
        action: "replace",
      },
      // One running execution parked at no wait node, one waiting.
      inFlightExecutionIds: ["exec_running", "exec_wait_1"],
      waitStates: [createWaitState("1", "exec_wait_1")],
      enableResumes: true,
      ...callbacks,
    });

    expect(callOrder).toEqual(["cancel", "start"]);
    expect(callbacks.cancelInFlightRuns).toHaveBeenCalledWith(
      "appointment.rescheduled"
    );
    // The wait state listens for any event, and the replace still wins.
    expect(callbacks.resumeWaitStates).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "running",
      executionId: "exec_replacement",
      runId: "run_replacement",
      runMode: "test",
      cancelledExecutions: 2,
      cancelledWaits: 3,
    });
  });

  it("cancels every in-flight run for a cancel action", async () => {
    const callbacks = createCallbacks({
      cancelInFlightRuns: async () => ({
        cancelledExecutions: 2,
        cancelledWaits: 1,
        failedExecutions: ["exec_failed"],
      }),
      resumeWaitStates: async () => 1,
    });

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: "appointment.cancelled",
        correlationKey: "abc",
        action: "cancel",
      },
      // An execution with no wait state still gets cancelled.
      inFlightExecutionIds: ["exec_running", "exec_wait_1"],
      waitStates: [
        createWaitState("1", "exec_wait_1", ["appointment.cancelled"]),
      ],
      enableResumes: true,
      ...callbacks,
    });

    expect(callbacks.cancelInFlightRuns).toHaveBeenCalledTimes(1);
    // The policy wins over the wait: the run is cancelled, never resumed.
    expect(callbacks.resumeWaitStates).not.toHaveBeenCalled();
    expect(callbacks.startExecution).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "cancelled",
      runMode: "live",
      cancelledExecutions: 2,
      cancelledWaits: 1,
      failedExecutions: ["exec_failed"],
    });
  });

  it("ignores a cancel action that finds nothing in flight", async () => {
    const callbacks = createCallbacks();

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: "appointment.cancelled",
        correlationKey: "abc",
        action: "cancel",
      },
      inFlightExecutionIds: [],
      waitStates: [],
      enableResumes: true,
      ...callbacks,
    });

    expect(callbacks.cancelInFlightRuns).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "ignored",
      runMode: "live",
      reason: "no_in_flight_runs",
    });
  });

  it("resumes the wait states listening for this event type", async () => {
    const callbacks = createCallbacks({ resumeWaitStates: async () => 1 });

    const result = await orchestrateTriggerExecution({
      runMode: "test",
      routing: {
        eventType: "appointment.confirmed",
        correlationKey: "abc",
        action: "ignore",
        ignoreReason: "event_not_mapped",
      },
      inFlightExecutionIds: ["exec_wait_1", "exec_wait_2"],
      waitStates: [
        createWaitState("1", "exec_wait_1", [
          "appointment.confirmed",
          "appointment.cancelled",
        ]),
        createWaitState("2", "exec_wait_2", ["appointment.rescheduled"]),
      ],
      enableResumes: true,
      ...callbacks,
    });

    expect(callbacks.resumeWaitStates).toHaveBeenCalledTimes(1);
    expect(callbacks.startExecution).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "resumed",
      resumedCount: 1,
      runMode: "test",
    });
  });

  it("resumes a wait state whose waitForEvents list is empty", async () => {
    const callbacks = createCallbacks({ resumeWaitStates: async () => 1 });

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: "anything.happened",
        correlationKey: "abc",
        action: "ignore",
        ignoreReason: "event_not_mapped",
      },
      inFlightExecutionIds: ["exec_wait_1"],
      waitStates: [createWaitState("1", "exec_wait_1", [])],
      enableResumes: true,
      ...callbacks,
    });

    expect(result).toEqual({
      status: "resumed",
      resumedCount: 1,
      runMode: "live",
    });
  });

  // Which waits an event wakes is resume matching's own knowledge; the
  // orchestrator delegates and trusts the returned count, so a zero means
  // the ignore outcome stands.
  it("reports ignored when resume matching wakes nothing", async () => {
    const callbacks = createCallbacks({ resumeWaitStates: async () => 0 });

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: "appointment.confirmed",
        correlationKey: "abc",
        action: "ignore",
        ignoreReason: "event_not_mapped",
      },
      inFlightExecutionIds: ["exec_wait_1"],
      waitStates: [
        createWaitState("1", "exec_wait_1", ["appointment.rescheduled"]),
      ],
      enableResumes: true,
      ...callbacks,
    });

    expect(callbacks.resumeWaitStates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "ignored",
      runMode: "live",
      reason: "event_not_mapped",
    });
  });

  it("skips resumes entirely when they are disabled", async () => {
    const callbacks = createCallbacks({ resumeWaitStates: async () => 1 });

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: "appointment.confirmed",
        correlationKey: "abc",
        action: "start",
      },
      inFlightExecutionIds: ["exec_wait_1"],
      waitStates: [
        createWaitState("1", "exec_wait_1", ["appointment.confirmed"]),
      ],
      enableResumes: false,
      ...callbacks,
    });

    expect(callbacks.resumeWaitStates).not.toHaveBeenCalled();
    expect(callbacks.startExecution).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "running",
      executionId: "exec_started",
      runId: "run_started",
      runMode: "live",
    });
  });

  // The waiting run consumes the event: resumes run before start, so a Start
  // mapping that a waiting run is listening for wakes that run instead of
  // opening a second one for the same entity.
  it("lets a waiting run consume a Start event instead of starting a new run", async () => {
    const callbacks = createCallbacks({ resumeWaitStates: async () => 1 });

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: "appointment.confirmed",
        correlationKey: "abc",
        action: "start",
      },
      inFlightExecutionIds: ["exec_wait_1"],
      waitStates: [
        createWaitState("1", "exec_wait_1", ["appointment.confirmed"]),
      ],
      enableResumes: true,
      ...callbacks,
    });

    expect(callbacks.resumeWaitStates).toHaveBeenCalledTimes(1);
    expect(callbacks.startExecution).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "resumed",
      resumedCount: 1,
      runMode: "live",
    });
  });

  it("starts a run when a Start event matches no waiting run", async () => {
    const callbacks = createCallbacks();

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: "appointment.created",
        correlationKey: "abc",
        action: "start",
      },
      inFlightExecutionIds: ["exec_wait_1"],
      waitStates: [
        createWaitState("1", "exec_wait_1", ["appointment.confirmed"]),
      ],
      enableResumes: true,
      ...callbacks,
    });

    expect(callbacks.startExecution).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "running",
      executionId: "exec_started",
      runId: "run_started",
      runMode: "live",
    });
  });

  it("starts a run when every matching wait state resume fails", async () => {
    const callbacks = createCallbacks({ resumeWaitStates: async () => 0 });

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      routing: {
        eventType: "appointment.confirmed",
        correlationKey: "abc",
        action: "start",
      },
      inFlightExecutionIds: ["exec_wait_1"],
      waitStates: [
        createWaitState("1", "exec_wait_1", ["appointment.confirmed"]),
      ],
      enableResumes: true,
      ...callbacks,
    });

    expect(callbacks.resumeWaitStates).toHaveBeenCalledTimes(1);
    expect(callbacks.startExecution).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "running",
      executionId: "exec_started",
      runId: "run_started",
      runMode: "live",
    });
  });
});
