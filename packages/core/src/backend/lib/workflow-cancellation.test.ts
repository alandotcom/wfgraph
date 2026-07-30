import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  announceSupersededRuns,
  cancelInFlightRuns,
} from "./workflow-cancellation";

const {
  sendWorkflowCancelRequestedMock,
  logWorkflowAuditEventMock,
  endInFlightExecutionMock,
  markWaitingStatesCancelledMock,
} = vi.hoisted(() => ({
  sendWorkflowCancelRequestedMock: vi.fn(),
  logWorkflowAuditEventMock: vi.fn(),
  endInFlightExecutionMock: vi.fn(),
  markWaitingStatesCancelledMock: vi.fn(),
}));

vi.mock("#src/backend/lib/inngest/runtime-events", () => ({
  sendWorkflowCancelRequested: sendWorkflowCancelRequestedMock,
}));

vi.mock("#src/backend/lib/workflow-audit", () => ({
  logWorkflowAuditEvent: logWorkflowAuditEventMock,
}));

vi.mock("#src/backend/lib/workflow-wait-state", () => ({
  endInFlightExecution: endInFlightExecutionMock,
  markWaitingStatesCancelled: markWaitingStatesCancelledMock,
}));

describe("cancelInFlightRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendWorkflowCancelRequestedMock.mockResolvedValue(undefined);
    endInFlightExecutionMock.mockResolvedValue(true);
    markWaitingStatesCancelledMock.mockResolvedValue([]);
    logWorkflowAuditEventMock.mockResolvedValue(undefined);
  });

  it("only marks executions and waits cancelled when cancel dispatch succeeds", async () => {
    sendWorkflowCancelRequestedMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("dispatch failed"));
    markWaitingStatesCancelledMock.mockResolvedValueOnce(["wait_1", "wait_2"]);

    const summary = await cancelInFlightRuns({
      workflowId: "workflow_1",
      executionIds: ["exec_success", "exec_failed"],
      waitStates: [
        { id: "wait_1", executionId: "exec_success" },
        { id: "wait_2", executionId: "exec_success" },
        { id: "wait_3", executionId: "exec_failed" },
      ],
      reason: "Cancelled by event",
      eventName: "appointment.cancelled",
    });

    expect(sendWorkflowCancelRequestedMock).toHaveBeenCalledTimes(2);
    expect(endInFlightExecutionMock).toHaveBeenCalledTimes(1);
    expect(endInFlightExecutionMock).toHaveBeenCalledWith({
      executionId: "exec_success",
      status: "canceled",
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
    expect(summary).toEqual({
      endedExecutionIds: ["exec_success"],
      failedExecutionIds: ["exec_failed"],
    });
  });

  it("cancels an in-flight execution that has no wait state", async () => {
    const summary = await cancelInFlightRuns({
      workflowId: "workflow_1",
      executionIds: ["exec_running"],
      waitStates: [],
      reason: "Cancelled by event appointment.rescheduled",
      eventName: "appointment.rescheduled",
    });

    expect(sendWorkflowCancelRequestedMock).toHaveBeenCalledWith({
      executionId: "exec_running",
      workflowId: "workflow_1",
      reason: "Cancelled by event appointment.rescheduled",
      requestedBy: "workflow_1",
      eventType: "appointment.rescheduled",
    });
    expect(endInFlightExecutionMock).toHaveBeenCalledWith({
      executionId: "exec_running",
      status: "canceled",
      error: "Cancelled by event appointment.rescheduled",
    });
    expect(markWaitingStatesCancelledMock).toHaveBeenCalledWith([]);
    expect(summary).toEqual({
      endedExecutionIds: ["exec_running"],
      failedExecutionIds: [],
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
    });

    expect(sendWorkflowCancelRequestedMock).toHaveBeenCalledTimes(1);
    expect(summary.endedExecutionIds).toEqual(["exec_1"]);
    expect(markWaitingStatesCancelledMock).toHaveBeenCalledWith([
      "wait_1",
      "wait_2",
    ]);
  });

  // The compare-and-set race: the run finished between the caller's in-flight
  // query and this write, so the row keeps its terminal status.
  it("does not count or audit an execution that finished before the cancel write", async () => {
    endInFlightExecutionMock
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
      eventName: "appointment.cancelled",
    });

    expect(endInFlightExecutionMock).toHaveBeenCalledTimes(2);
    expect(logWorkflowAuditEventMock).toHaveBeenCalledTimes(1);
    expect(logWorkflowAuditEventMock).toHaveBeenCalledWith({
      workflowId: "workflow_1",
      executionId: "exec_still_waiting",
      eventType: "run_cancelled",
      message: "Cancelled by event",
      metadata: { eventName: "appointment.cancelled" },
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
      endedExecutionIds: ["exec_still_waiting"],
      failedExecutionIds: [],
    });
  });
});

// The rows are already terminal when this runs -- the entity lock flipped them --
// so there is no compare-and-set here and no lost race to report. What is left is
// the signal and the timeline.
describe("announceSupersededRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendWorkflowCancelRequestedMock.mockResolvedValue(undefined);
    logWorkflowAuditEventMock.mockResolvedValue(undefined);
  });

  it("signals each displaced run and says why on its timeline", async () => {
    const summary = await announceSupersededRuns({
      workflowId: "workflow_1",
      executionIds: ["exec_old"],
      reason: "Superseded by a newer start from appointment.rescheduled",
      eventName: "appointment.rescheduled",
    });

    expect(sendWorkflowCancelRequestedMock).toHaveBeenCalledTimes(1);
    expect(endInFlightExecutionMock).not.toHaveBeenCalled();
    expect(logWorkflowAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "exec_old",
        eventType: "run_superseded",
      })
    );
    expect(summary).toEqual({ failedExecutionIds: [] });
  });

  // A signal that does not land leaves a live run against a superseded row, and
  // the id travels back so the caller can say so.
  it("names the runs no signal reached", async () => {
    sendWorkflowCancelRequestedMock.mockRejectedValueOnce(
      new Error("dispatch failed")
    );

    const summary = await announceSupersededRuns({
      workflowId: "workflow_1",
      executionIds: ["exec_old"],
      reason: "Superseded by a newer start",
    });

    expect(summary).toEqual({ failedExecutionIds: ["exec_old"] });
  });
});
