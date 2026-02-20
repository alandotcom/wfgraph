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
      dryRun: false,
      eventType: undefined,
      correlationKey: undefined,
      routingDecision: { kind: "ignore", reason: "missing_event_type" },
      waitStates: [],
      enableResumes: true,
      startExecution: vi.fn(async () => ({
        executionId: "exec_1",
        dryRun: false,
      })),
      cancelWaitStates: vi.fn(async () => ({
        cancelledExecutions: 0,
        cancelledWaits: 0,
      })),
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(result).toEqual({
      status: "ignored",
      reason: "missing_event_type",
    });
  });

  it("ignores restart events when no waiting runs exist", async () => {
    const result = await orchestrateTriggerExecution({
      dryRun: false,
      eventType: "event.update",
      correlationKey: "abc",
      routingDecision: { kind: "restart" },
      waitStates: [],
      enableResumes: true,
      startExecution: vi.fn(async () => ({
        executionId: "exec_1",
        dryRun: false,
      })),
      cancelWaitStates: vi.fn(async () => ({
        cancelledExecutions: 0,
        cancelledWaits: 0,
      })),
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(result).toEqual({
      status: "ignored",
      reason: "no_waiting_runs",
    });
  });

  it("starts a dry-run restart and returns simulated cancellation summary", async () => {
    const startExecution = vi.fn(async () => ({
      executionId: "exec_restart",
      runId: "run_restart",
      dryRun: true,
    }));
    const cancelWaitStates = vi.fn(async () => ({
      cancelledExecutions: 9,
      cancelledWaits: 9,
    }));

    const result = await orchestrateTriggerExecution({
      dryRun: true,
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

    expect(startExecution).toHaveBeenCalledTimes(1);
    expect(cancelWaitStates).toHaveBeenCalledTimes(0);
    expect(result).toEqual({
      status: "running",
      executionId: "exec_restart",
      runId: "run_restart",
      dryRun: true,
      simulated: true,
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
      dryRun: false,
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
        dryRun: false,
      })),
      cancelWaitStates,
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(cancelWaitStates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "cancelled",
      dryRun: false,
      cancelledExecutions: 2,
      cancelledWaits: 3,
      failedExecutions: ["exec_failed"],
    });
  });

  it("simulates resume counts for dry-run webhooks", async () => {
    const result = await orchestrateTriggerExecution({
      dryRun: true,
      eventType: "event.update",
      correlationKey: "abc",
      routingDecision: { kind: "start" },
      waitStates: [
        createWaitState("1", "exec_wait_1", "event.update,event.create"),
        createWaitState("2", "exec_wait_2", "event.delete"),
      ],
      enableResumes: true,
      startExecution: vi.fn(async () => ({
        executionId: "exec_start",
        dryRun: true,
      })),
      cancelWaitStates: vi.fn(async () => ({
        cancelledExecutions: 0,
        cancelledWaits: 0,
      })),
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(result).toEqual({
      status: "resumed",
      resumedCount: 1,
      dryRun: true,
      simulated: true,
    });
  });

  it("ignores event_not_configured decisions even when event type is absent", async () => {
    const startExecution = vi.fn(async () => ({
      executionId: "exec_start",
      dryRun: false,
    }));

    const result = await orchestrateTriggerExecution({
      dryRun: false,
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
      reason: "event_not_configured",
    });
  });

  it("cancels waiting runs for stop decisions even when event type is absent", async () => {
    const cancelWaitStates = vi.fn(async () => ({
      cancelledExecutions: 1,
      cancelledWaits: 1,
    }));

    const result = await orchestrateTriggerExecution({
      dryRun: false,
      eventType: undefined,
      correlationKey: "abc",
      routingDecision: { kind: "stop" },
      waitStates: [createWaitState("1", "exec_wait_1")],
      enableResumes: true,
      startExecution: vi.fn(async () => ({
        executionId: "exec_start",
        dryRun: false,
      })),
      cancelWaitStates,
      resumeWaitStates: vi.fn(async () => 0),
    });

    expect(cancelWaitStates).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: "cancelled",
      dryRun: false,
      cancelledExecutions: 1,
      cancelledWaits: 1,
    });
  });
});
