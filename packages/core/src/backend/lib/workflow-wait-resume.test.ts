import { beforeEach, describe, expect, it, mock, vi } from "bun:test";

const sendWorkflowWaitSignalMock = vi.fn();
const logWorkflowAuditEventMock = vi.fn();
const markExecutionRunningMock = vi.fn();
const markWaitStateStatusMock = vi.fn();

mock.module("@/backend/lib/inngest/runtime-events", () => ({
  sendWorkflowWaitSignal: sendWorkflowWaitSignalMock,
  sendWorkflowRunRequested: vi.fn(),
  sendWorkflowCancelRequested: vi.fn(),
}));

mock.module("@/backend/lib/workflow-audit", () => ({
  logWorkflowAuditEvent: logWorkflowAuditEventMock,
}));

mock.module("@/backend/lib/workflow-wait-state", () => ({
  markExecutionRunning: markExecutionRunningMock,
  markWaitStateStatus: markWaitStateStatusMock,
  markExecutionCancelled: vi.fn(),
  markWaitingStatesCancelled: vi.fn(),
  createWaitState: vi.fn(),
  listExecutionWaitingStates: vi.fn(),
  listWorkflowWaitingStatesByCorrelation: vi.fn(),
}));

const { resumeMatchingWaitHooks } = await import("./workflow-wait-resume");

function createWaitState(
  id: string,
  executionId: string,
  opts?: {
    hookToken?: string | null;
    metadata?: Record<string, unknown> | null;
  }
) {
  return {
    id,
    executionId,
    nodeId: `node_${id}`,
    hookToken: opts?.hookToken === undefined ? `token_${id}` : opts.hookToken,
    metadata: opts?.metadata ?? null,
  };
}

describe("resumeMatchingWaitHooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendWorkflowWaitSignalMock.mockResolvedValue(undefined);
    markWaitStateStatusMock.mockResolvedValue(true);
    markExecutionRunningMock.mockResolvedValue(undefined);
    logWorkflowAuditEventMock.mockResolvedValue(undefined);
  });

  it("returns 0 when eventType is undefined", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: undefined,
      payload: { data: "test" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
  });

  it("returns 0 when eventType is empty string", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "",
      payload: { data: "test" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
  });

  it("returns 0 for empty waitStates array", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { data: "test" },
      waitStates: [],
    });

    expect(result).toBe(0);
  });

  it("skips wait states without a hookToken", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { data: "test" },
      waitStates: [
        createWaitState("1", "exec_1", { hookToken: null }),
        createWaitState("2", "exec_2", { hookToken: null }),
      ],
    });

    expect(result).toBe(0);
    expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
  });

  it("resumes a single wait state with hookToken", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { key: "value" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(1);
    expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(1);
    expect(sendWorkflowWaitSignalMock).toHaveBeenCalledWith({
      executionId: "exec_1",
      nodeId: "node_1",
      token: "token_1",
      eventType: "event.update",
      correlationKey: undefined,
      payload: { key: "value" },
    });
    expect(markWaitStateStatusMock).toHaveBeenCalledWith({
      waitStateId: "1",
      status: "resumed",
    });
    expect(markExecutionRunningMock).toHaveBeenCalledWith("exec_1");
    expect(logWorkflowAuditEventMock).toHaveBeenCalledTimes(1);
  });

  it("resumes multiple wait states and returns total count", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1"),
        createWaitState("2", "exec_2"),
        createWaitState("3", "exec_3"),
      ],
    });

    expect(result).toBe(3);
    expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(3);
    expect(markWaitStateStatusMock).toHaveBeenCalledTimes(3);
    expect(markExecutionRunningMock).toHaveBeenCalledTimes(3);
  });

  it("extracts correlationKey from wait state metadata", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1", {
          metadata: { correlationKey: "corr_123" },
        }),
      ],
    });

    expect(result).toBe(1);
    expect(sendWorkflowWaitSignalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationKey: "corr_123",
      })
    );
  });

  it("passes undefined correlationKey when metadata.correlationKey is not a string", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1", {
          metadata: { correlationKey: 42 },
        }),
      ],
    });

    expect(result).toBe(1);
    expect(sendWorkflowWaitSignalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationKey: undefined,
      })
    );
  });

  it("handles null metadata gracefully", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [createWaitState("1", "exec_1", { metadata: null })],
    });

    expect(result).toBe(1);
    expect(sendWorkflowWaitSignalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationKey: undefined,
      })
    );
  });

  it("returns 0 for a wait state when markWaitStateStatus returns false", async () => {
    markWaitStateStatusMock.mockResolvedValue(false);

    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(1);
    expect(markWaitStateStatusMock).toHaveBeenCalledTimes(1);
    expect(markExecutionRunningMock).not.toHaveBeenCalled();
    expect(logWorkflowAuditEventMock).not.toHaveBeenCalled();
  });

  it("counts 0 for failed resumes and continues processing others", async () => {
    sendWorkflowWaitSignalMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("signal failed"))
      .mockResolvedValueOnce(undefined);

    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1"),
        createWaitState("2", "exec_2"),
        createWaitState("3", "exec_3"),
      ],
    });

    expect(result).toBe(2);
    expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(3);
  });

  it("counts partial successes when some markWaitStateStatus return false", async () => {
    markWaitStateStatusMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1"),
        createWaitState("2", "exec_2"),
      ],
    });

    expect(result).toBe(1);
  });

  it("mixes hookToken present and absent wait states", async () => {
    const result = await resumeMatchingWaitHooks({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        createWaitState("1", "exec_1", { hookToken: "token_1" }),
        createWaitState("2", "exec_2", { hookToken: null }),
        createWaitState("3", "exec_3", { hookToken: "token_3" }),
      ],
    });

    expect(result).toBe(2);
    expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(2);
  });

  it("logs audit event with correct eventType", async () => {
    await resumeMatchingWaitHooks({
      workflowId: "workflow_audit",
      eventType: "appointment.rescheduled",
      payload: { appointment: { id: "apt_1" } },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(logWorkflowAuditEventMock).toHaveBeenCalledWith({
      workflowId: "workflow_audit",
      executionId: "exec_1",
      eventType: "run_resumed",
      message: "Run resumed from wait on appointment.rescheduled",
      metadata: {
        eventType: "appointment.rescheduled",
      },
    });
  });

  describe("waitForEvents filtering", () => {
    it("resumes when eventType matches one of the waitForEvents entries", async () => {
      const result = await resumeMatchingWaitHooks({
        workflowId: "workflow_1",
        eventType: "appointment.confirmed",
        payload: {},
        waitStates: [
          createWaitState("1", "exec_1", {
            metadata: {
              waitForEvents: ["appointment.confirmed", "appointment.cancelled"],
            },
          }),
        ],
      });

      expect(result).toBe(1);
      expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(1);
    });

    it("skips when eventType does not match any waitForEvents entry", async () => {
      const result = await resumeMatchingWaitHooks({
        workflowId: "workflow_1",
        eventType: "appointment.rescheduled",
        payload: {},
        waitStates: [
          createWaitState("1", "exec_1", {
            metadata: {
              waitForEvents: ["appointment.confirmed", "appointment.cancelled"],
            },
          }),
        ],
      });

      expect(result).toBe(0);
      expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
    });

    it("resumes when waitForEvents is an empty array (matches any event)", async () => {
      const result = await resumeMatchingWaitHooks({
        workflowId: "workflow_1",
        eventType: "anything.happened",
        payload: {},
        waitStates: [
          createWaitState("1", "exec_1", {
            metadata: { waitForEvents: [] },
          }),
        ],
      });

      expect(result).toBe(1);
      expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(1);
    });

    it("resumes when waitForEvents is not set in metadata", async () => {
      const result = await resumeMatchingWaitHooks({
        workflowId: "workflow_1",
        eventType: "anything.happened",
        payload: {},
        waitStates: [
          createWaitState("1", "exec_1", {
            metadata: { correlationKey: "corr_1" },
          }),
        ],
      });

      expect(result).toBe(1);
      expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(1);
    });

    it("filters independently per wait state", async () => {
      const result = await resumeMatchingWaitHooks({
        workflowId: "workflow_1",
        eventType: "appointment.confirmed",
        payload: {},
        waitStates: [
          createWaitState("1", "exec_1", {
            metadata: { waitForEvents: ["appointment.confirmed"] },
          }),
          createWaitState("2", "exec_2", {
            metadata: { waitForEvents: ["appointment.cancelled"] },
          }),
          createWaitState("3", "exec_3", {
            metadata: { waitForEvents: [] },
          }),
        ],
      });

      expect(result).toBe(2);
      expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(2);
    });

    // Metadata arrives as JSON, so a non-string entry is representable; the
    // string entries around it still decide the match.
    it("matches on the string entries of a mixed waitForEvents array", async () => {
      const result = await resumeMatchingWaitHooks({
        workflowId: "workflow_1",
        eventType: "appointment.confirmed",
        payload: {},
        waitStates: [
          createWaitState("1", "exec_1", {
            metadata: { waitForEvents: [42, "appointment.confirmed"] },
          }),
          createWaitState("2", "exec_2", {
            metadata: { waitForEvents: [42, "appointment.cancelled"] },
          }),
        ],
      });

      expect(result).toBe(1);
      expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(1);
    });
  });
});
