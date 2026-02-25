import { describe, expect, it, vi } from "bun:test";
import { orchestrateTriggerExecution } from "./trigger-orchestrator.workflows";

function createWaitState(
  id: string,
  executionId: string,
  waitForEvents?: string
) {
  return {
    id,
    executionId,
    nodeId: `node_${id}`,
    hookToken: `token_${id}`,
    metadata: waitForEvents ? { waitForEvents } : null,
  };
}

describe("orchestrateTriggerExecution", () => {
  it("ignores missing event type when routing requires it", async () => {
    const result = await orchestrateTriggerExecution({
      runMode: "live",
      eventType: undefined,
      correlationKey: undefined,
      routingDecision: { kind: "ignore", reason: "missing_event_type" },
      waitStates: [],
      enableResumes: true,
      startExecution: vi.fn(async () => ({
        executionId: "exec_1",
        runMode: "live" as const,
      })),
      cancelWaitStates: vi.fn(async () => ({
        cancelledExecutions: 0,
        cancelledWaits: 0,
      })),
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(result).toEqual({
      status: "ignored",
      runMode: "live",
      reason: "missing_event_type",
    });
  });

  it("starts a new execution for restart when no waiting runs exist", async () => {
    const startExecution = vi.fn(async () => ({
      executionId: "exec_1",
      runId: "run_1",
      runMode: "live" as const,
    }));

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      eventType: "event.update",
      correlationKey: "abc",
      routingDecision: { kind: "restart" },
      waitStates: [],
      enableResumes: true,
      startExecution,
      cancelWaitStates: vi.fn(async () => ({
        cancelledExecutions: 0,
        cancelledWaits: 0,
      })),
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(startExecution).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "running",
      executionId: "exec_1",
      runId: "run_1",
      runMode: "live",
    });
  });

  it("restarts by cancelling waits and starting a new run", async () => {
    const startExecution = vi.fn(async () => ({
      executionId: "exec_restart",
      runId: "run_restart",
      runMode: "test" as const,
    }));
    const cancelWaitStates = vi.fn(async () => ({
      cancelledExecutions: 2,
      cancelledWaits: 3,
    }));

    const result = await orchestrateTriggerExecution({
      runMode: "test",
      eventType: "event.update",
      correlationKey: "abc",
      routingDecision: { kind: "restart" },
      waitStates: [
        createWaitState("1", "exec_wait_1"),
        createWaitState("2", "exec_wait_1"),
        createWaitState("3", "exec_wait_2"),
      ],
      enableResumes: true,
      startExecution,
      cancelWaitStates,
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(cancelWaitStates).toHaveBeenCalledTimes(1);
    expect(startExecution).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "running",
      executionId: "exec_restart",
      runId: "run_restart",
      runMode: "test",
      cancelledExecutions: 2,
      cancelledWaits: 3,
    });
  });

  it("cancels waiting runs for stop events", async () => {
    const cancelWaitStates = vi.fn(async () => ({
      cancelledExecutions: 2,
      cancelledWaits: 3,
      failedExecutions: ["exec_failed"],
    }));

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      eventType: "event.delete",
      correlationKey: "abc",
      routingDecision: { kind: "stop" },
      waitStates: [
        createWaitState("1", "exec_wait_1"),
        createWaitState("2", "exec_wait_1"),
        createWaitState("3", "exec_wait_2"),
      ],
      enableResumes: true,
      startExecution: vi.fn(async () => ({
        executionId: "exec_start",
        runMode: "live" as const,
      })),
      cancelWaitStates,
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(cancelWaitStates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "cancelled",
      runMode: "live",
      cancelledExecutions: 2,
      cancelledWaits: 3,
      failedExecutions: ["exec_failed"],
    });
  });

  it("resumes matching waiting runs when enabled", async () => {
    const resumeWaitStates = vi.fn(async () => 1);
    const startExecution = vi.fn(async () => ({
      executionId: "exec_start",
      runMode: "test" as const,
    }));

    const result = await orchestrateTriggerExecution({
      runMode: "test",
      eventType: "event.update",
      correlationKey: "abc",
      routingDecision: { kind: "start" },
      waitStates: [
        createWaitState("1", "exec_wait_1", "event.update,event.create"),
        createWaitState("2", "exec_wait_2", "event.delete"),
      ],
      enableResumes: true,
      startExecution,
      cancelWaitStates: vi.fn(async () => ({
        cancelledExecutions: 0,
        cancelledWaits: 0,
      })),
      resumeWaitStates,
    });

    expect(resumeWaitStates).toHaveBeenCalledTimes(1);
    expect(startExecution).toHaveBeenCalledTimes(0);
    expect(result).toEqual({
      status: "resumed",
      resumedCount: 1,
      runMode: "test",
    });
  });

  it("ignores event_not_configured decisions", async () => {
    const startExecution = vi.fn(async () => ({
      executionId: "exec_start",
      runMode: "live" as const,
    }));

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      eventType: undefined,
      correlationKey: "abc",
      routingDecision: { kind: "ignore", reason: "event_not_configured" },
      waitStates: [],
      enableResumes: false,
      startExecution,
      cancelWaitStates: vi.fn(async () => ({
        cancelledExecutions: 0,
        cancelledWaits: 0,
      })),
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(startExecution).toHaveBeenCalledTimes(0);
    expect(result).toEqual({
      status: "ignored",
      runMode: "live",
      reason: "event_not_configured",
    });
  });

  it("cancels waiting runs for stop decisions even when event type is absent", async () => {
    const cancelWaitStates = vi.fn(async () => ({
      cancelledExecutions: 1,
      cancelledWaits: 1,
    }));

    const result = await orchestrateTriggerExecution({
      runMode: "live",
      eventType: undefined,
      correlationKey: "abc",
      routingDecision: { kind: "stop" },
      waitStates: [createWaitState("1", "exec_wait_1")],
      enableResumes: true,
      startExecution: vi.fn(async () => ({
        executionId: "exec_start",
        runMode: "live" as const,
      })),
      cancelWaitStates,
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(cancelWaitStates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "cancelled",
      runMode: "live",
      cancelledExecutions: 1,
      cancelledWaits: 1,
    });
  });
});
