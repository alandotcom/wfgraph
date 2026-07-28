import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelInFlightRuns } from "./workflow-cancellation";

// vi.hoisted, because vitest lifts vi.mock above every import, and the factories
// below read these the moment the module under test is imported.
const {
  sendWorkflowCancelRequestedMock,
  logWorkflowAuditEventMock,
  markExecutionCancelledMock,
  markWaitingStatesCancelledMock,
} = vi.hoisted(() => ({
  sendWorkflowCancelRequestedMock: vi.fn(),
  logWorkflowAuditEventMock: vi.fn(),
  markExecutionCancelledMock: vi.fn(),
  markWaitingStatesCancelledMock: vi.fn(),
}));

vi.mock("@/backend/lib/inngest/runtime-events", () => ({
  sendWorkflowCancelRequested: sendWorkflowCancelRequestedMock,
}));

vi.mock("@/backend/lib/workflow-audit", () => ({
  logWorkflowAuditEvent: logWorkflowAuditEventMock,
}));

vi.mock("@/backend/lib/workflow-wait-state", () => ({
  markExecutionCancelled: markExecutionCancelledMock,
  markWaitingStatesCancelled: markWaitingStatesCancelledMock,
}));

describe("cancelInFlightRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendWorkflowCancelRequestedMock.mockResolvedValue(undefined);
    markExecutionCancelledMock.mockResolvedValue(true);
    markWaitingStatesCancelledMock.mockResolvedValue([]);
    logWorkflowAuditEventMock.mockResolvedValue(undefined);
  });

  it("only marks executions and waits cancelled when cancel dispatch succeeds", async () => {
    sendWorkflowCancelRequestedMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("dispatch failed"));
    markWaitingStatesCancelledMock.mockResolvedValueOnce(["wait_1", "wait_2"]);

    const logger = { error: vi.fn(), info: vi.fn() };

    const summary = await cancelInFlightRuns({
      workflowId: "workflow_1",
      executionIds: ["exec_success", "exec_failed"],
      waitStates: [
        { id: "wait_1", executionId: "exec_success" },
        { id: "wait_2", executionId: "exec_success" },
        { id: "wait_3", executionId: "exec_failed" },
      ],
      reason: "Cancelled by event",
      eventType: "appointment.cancelled",
      logger,
    });

    expect(sendWorkflowCancelRequestedMock).toHaveBeenCalledTimes(2);
    expect(markExecutionCancelledMock).toHaveBeenCalledTimes(1);
    expect(markExecutionCancelledMock).toHaveBeenCalledWith({
      executionId: "exec_success",
      error: "Cancelled by event",
    });
    expect(markWaitingStatesCancelledMock).toHaveBeenCalledWith([
      "wait_1",
      "wait_2",
    ]);
    // One run_cancelled for the winner, one run_cancel_requested recording
    // that the other run's cancel signal never went out.
    expect(logWorkflowAuditEventMock).toHaveBeenCalledTimes(2);
    expect(logWorkflowAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "exec_failed",
        eventType: "run_cancel_requested",
        metadata: expect.objectContaining({ outcome: "send_failed" }),
      })
    );
    expect(logger.error).toHaveBeenCalledTimes(1);

    expect(summary).toEqual({
      cancelledExecutions: 1,
      cancelledWaits: 2,
      failedExecutions: ["exec_failed"],
    });
  });

  it("cancels an in-flight execution that has no wait state", async () => {
    const summary = await cancelInFlightRuns({
      workflowId: "workflow_1",
      executionIds: ["exec_running"],
      waitStates: [],
      reason: "Replaced by event appointment.rescheduled",
      eventType: "appointment.rescheduled",
      logger: { error: vi.fn(), info: vi.fn() },
    });

    expect(sendWorkflowCancelRequestedMock).toHaveBeenCalledWith({
      executionId: "exec_running",
      workflowId: "workflow_1",
      reason: "Replaced by event appointment.rescheduled",
      requestedBy: "workflow_1",
      eventType: "appointment.rescheduled",
    });
    expect(markWaitingStatesCancelledMock).toHaveBeenCalledWith([]);
    expect(summary).toEqual({
      cancelledExecutions: 1,
      cancelledWaits: 0,
      failedExecutions: undefined,
    });
  });

  it("sends one cancel per execution when several wait states share a run", async () => {
    markWaitingStatesCancelledMock.mockResolvedValueOnce(["wait_1", "wait_2"]);

    const summary = await cancelInFlightRuns({
      workflowId: "workflow_1",
      executionIds: ["exec_1", "exec_1"],
      waitStates: [
        { id: "wait_1", executionId: "exec_1" },
        { id: "wait_2", executionId: "exec_1" },
      ],
      reason: "Cancelled by event",
      logger: { error: vi.fn(), info: vi.fn() },
    });

    expect(sendWorkflowCancelRequestedMock).toHaveBeenCalledTimes(1);
    expect(summary.cancelledExecutions).toBe(1);
    expect(summary.cancelledWaits).toBe(2);
  });

  // The compare-and-set race: the run finished between the caller's in-flight
  // query and this write, so the row keeps its terminal status.
  it("does not count or audit an execution that finished before the cancel write", async () => {
    markExecutionCancelledMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    markWaitingStatesCancelledMock.mockResolvedValueOnce(["wait_2"]);

    const summary = await cancelInFlightRuns({
      workflowId: "workflow_1",
      executionIds: ["exec_completed", "exec_still_waiting"],
      waitStates: [
        { id: "wait_1", executionId: "exec_completed" },
        { id: "wait_2", executionId: "exec_still_waiting" },
      ],
      reason: "Cancelled by event",
      eventType: "appointment.cancelled",
      logger: { error: vi.fn(), info: vi.fn() },
    });

    expect(markExecutionCancelledMock).toHaveBeenCalledTimes(2);
    expect(logWorkflowAuditEventMock).toHaveBeenCalledTimes(1);
    expect(logWorkflowAuditEventMock).toHaveBeenCalledWith({
      workflowId: "workflow_1",
      executionId: "exec_still_waiting",
      eventType: "run_cancelled",
      message: "Cancelled by event",
      metadata: { eventType: "appointment.cancelled" },
    });
    // The lost race's wait state joins the cleanup batch: its execution is
    // terminal, and a still-waiting row on it would silently swallow future
    // events via resume matching. The CAS inside markWaitingStatesCancelled
    // keeps this safe for legitimately resumed waits.
    expect(markWaitingStatesCancelledMock).toHaveBeenCalledWith([
      "wait_1",
      "wait_2",
    ]);
    expect(summary).toEqual({
      cancelledExecutions: 1,
      cancelledWaits: 1,
      failedExecutions: undefined,
    });
  });
});
