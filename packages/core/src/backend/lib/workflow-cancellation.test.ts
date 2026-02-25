import { beforeEach, describe, expect, it, mock, vi } from "bun:test";

const sendWorkflowCancelRequestedMock = vi.fn();
const logWorkflowAuditEventMock = vi.fn();
const markExecutionCancelledMock = vi.fn();
const markWaitingStatesCancelledMock = vi.fn();

mock.module("@/backend/lib/inngest/runtime-events", () => ({
  sendWorkflowCancelRequested: sendWorkflowCancelRequestedMock,
}));

mock.module("@/backend/lib/workflow-audit", () => ({
  logWorkflowAuditEvent: logWorkflowAuditEventMock,
}));

mock.module("@/backend/lib/workflow-wait-state", () => ({
  markExecutionCancelled: markExecutionCancelledMock,
  markWaitingStatesCancelled: markWaitingStatesCancelledMock,
}));

const { cancelWaitingRuns } = await import("./workflow-cancellation");

describe("cancelWaitingRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only marks executions and waits cancelled when cancel dispatch succeeds", async () => {
    sendWorkflowCancelRequestedMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("dispatch failed"));
    markWaitingStatesCancelledMock.mockResolvedValueOnce(["wait_1", "wait_2"]);
    markExecutionCancelledMock.mockResolvedValue(undefined);
    logWorkflowAuditEventMock.mockResolvedValue(undefined);

    const logger = {
      error: vi.fn(),
    };

    const summary = await cancelWaitingRuns({
      workflowId: "workflow_1",
      reason: "Cancelled by event",
      eventType: "event.delete",
      logger,
      waitStates: [
        { id: "wait_1", executionId: "exec_success" },
        { id: "wait_2", executionId: "exec_success" },
        { id: "wait_3", executionId: "exec_failed" },
      ],
    });

    expect(sendWorkflowCancelRequestedMock).toHaveBeenCalledTimes(2);
    expect(markWaitingStatesCancelledMock).toHaveBeenCalledWith([
      "wait_1",
      "wait_2",
    ]);
    expect(markExecutionCancelledMock).toHaveBeenCalledTimes(1);
    expect(markExecutionCancelledMock).toHaveBeenCalledWith({
      executionId: "exec_success",
      error: "Cancelled by event",
    });
    expect(logWorkflowAuditEventMock).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);

    expect(summary).toEqual({
      cancelledExecutions: 1,
      cancelledWaits: 2,
      failedExecutions: ["exec_failed"],
    });
  });
});
