import { beforeEach, describe, expect, it, vi } from "vitest";
import { resumeWaitsMatchingEvent } from "./workflow-wait-resume";

const {
  sendWorkflowWaitSignalMock,
  logWorkflowAuditEventMock,
  markExecutionRunningMock,
  markWaitStateStatusMock,
  loggerErrorMock,
  loggerWarnMock,
} = vi.hoisted(() => ({
  sendWorkflowWaitSignalMock: vi.fn(),
  logWorkflowAuditEventMock: vi.fn(),
  markExecutionRunningMock: vi.fn(),
  markWaitStateStatusMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

// Both this module and `wait-match` log through the app logger, and two of the
// cases below are about what reaches it rather than about what is returned.
vi.mock("#src/backend/lib/logger", () => ({
  getAppLogger: () => ({
    error: loggerErrorMock,
    warn: loggerWarnMock,
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("#src/backend/lib/inngest/runtime-events", () => ({
  sendWorkflowWaitSignal: sendWorkflowWaitSignalMock,
  sendWorkflowRunRequested: vi.fn(),
  sendWorkflowCancelRequested: vi.fn(),
}));

vi.mock("#src/backend/lib/workflow-audit", () => ({
  logWorkflowAuditEvent: logWorkflowAuditEventMock,
}));

vi.mock("#src/backend/lib/workflow-wait-state", () => ({
  markExecutionRunning: markExecutionRunningMock,
  markWaitStateStatus: markWaitStateStatusMock,
  markExecutionCancelled: vi.fn(),
  markWaitingStatesCancelled: vi.fn(),
  createWaitState: vi.fn(),
  listExecutionWaitingStates: vi.fn(),
  listWorkflowWaitsForEvent: vi.fn(),
}));

type Subscription = {
  event: string;
  match?: { expression: string; timestampPaths: string[] };
};

/**
 * A parked wait, holding the subscriptions it compiled when it parked.
 *
 * The row's own metadata is the matcher, so an edit to the node it parked on
 * cannot change what the run is owed. `subscribedEvents` is what the candidate
 * query narrows by, and it is set here to match so a row reaching this function
 * looks the way the query would have handed it over.
 */
function createWaitState(
  id: string,
  executionId: string,
  opts?: {
    resumeToken?: string | null;
    subscriptions?: Subscription[];
  }
) {
  const subscriptions = opts?.subscriptions ?? [{ event: "event.update" }];

  return {
    id,
    executionId,
    nodeId: `node_${id}`,
    resumeToken:
      opts?.resumeToken === undefined ? `token_${id}` : opts.resumeToken,
    subscribedEvents: subscriptions.map((subscription) => subscription.event),
    metadata: { waitFor: subscriptions } as Record<string, unknown> | null,
  };
}

describe("resumeWaitsMatchingEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendWorkflowWaitSignalMock.mockResolvedValue(undefined);
    markWaitStateStatusMock.mockResolvedValue(true);
    markExecutionRunningMock.mockResolvedValue(undefined);
    logWorkflowAuditEventMock.mockResolvedValue(undefined);
  });

  it("returns 0 when eventType is undefined", async () => {
    const result = await resumeWaitsMatchingEvent({
      workflowId: "workflow_1",
      eventType: undefined,
      payload: { data: "test" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
  });

  it("returns 0 when eventType is empty string", async () => {
    const result = await resumeWaitsMatchingEvent({
      workflowId: "workflow_1",
      eventType: "",
      payload: { data: "test" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
  });

  it("returns 0 for empty waitStates array", async () => {
    const result = await resumeWaitsMatchingEvent({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { data: "test" },
      waitStates: [],
    });

    expect(result).toBe(0);
  });

  it("skips wait states without a resume token", async () => {
    const result = await resumeWaitsMatchingEvent({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { data: "test" },
      waitStates: [
        createWaitState("1", "exec_1", { resumeToken: null }),
        createWaitState("2", "exec_2", { resumeToken: null }),
      ],
    });

    expect(result).toBe(0);
    expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
  });

  it("resumes a match-free subscription on the next occurrence", async () => {
    const result = await resumeWaitsMatchingEvent({
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
    const result = await resumeWaitsMatchingEvent({
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

  it("wakes nothing for a row whose metadata holds no subscriptions", async () => {
    const result = await resumeWaitsMatchingEvent({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        { ...createWaitState("1", "exec_1"), metadata: null },
        { ...createWaitState("2", "exec_2"), metadata: {} },
      ],
    });

    expect(result).toBe(0);
    expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
  });

  // A candidate row reached the matcher because its own `subscribed_events`
  // named this Event, so a `waitFor` that will not decode is a row this engine
  // wrote and cannot read. Silently, it looks exactly like an ordinary no-match.
  it("says so when a parked row's subscriptions will not decode", async () => {
    const result = await resumeWaitsMatchingEvent({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        {
          ...createWaitState("1", "exec_1"),
          metadata: { waitFor: "not a list of subscriptions" },
        },
      ],
    });

    expect(result).toBe(0);
    expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Parked wait holds subscriptions that will not decode"
    );
  });

  it("returns 0 for a wait state when markWaitStateStatus returns false", async () => {
    markWaitStateStatusMock.mockResolvedValue(false);

    const result = await resumeWaitsMatchingEvent({
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

    const result = await resumeWaitsMatchingEvent({
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

    const result = await resumeWaitsMatchingEvent({
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

  it("logs audit event with correct eventType", async () => {
    await resumeWaitsMatchingEvent({
      workflowId: "workflow_audit",
      eventType: "appointment.rescheduled",
      payload: { appointment: { id: "apt_1" } },
      waitStates: [
        createWaitState("1", "exec_1", {
          subscriptions: [{ event: "appointment.rescheduled" }],
        }),
      ],
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

  describe("the stored match decides", () => {
    // The owner's case: a run started by one Event, parked on a different one,
    // woken by the arrival whose payload names this run's entity and by no other.
    it("wakes the run whose match the payload satisfies, and no other", async () => {
      const parkedOn = (appointmentId: string) => ({
        event: "billing/payment.settled",
        match: {
          expression: `payload.appointmentId == "${appointmentId}"`,
          timestampPaths: [],
        },
      });

      const result = await resumeWaitsMatchingEvent({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { appointmentId: "appt_8813", amountCents: 4200 },
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [parkedOn("appt_8813")],
          }),
          createWaitState("2", "exec_2", {
            subscriptions: [parkedOn("appt_0001")],
          }),
        ],
      });

      expect(result).toBe(1);
      expect(sendWorkflowWaitSignalMock).toHaveBeenCalledTimes(1);
      expect(sendWorkflowWaitSignalMock).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: "exec_1" })
      );
    });

    it("wakes nothing when no arriving payload satisfies the match", async () => {
      const result = await resumeWaitsMatchingEvent({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { appointmentId: "appt_nobody_waits_for" },
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [
              {
                event: "billing/payment.settled",
                match: {
                  expression: 'payload.appointmentId == "appt_8813"',
                  timestampPaths: [],
                },
              },
            ],
          }),
        ],
      });

      expect(result).toBe(0);
      expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
    });

    // A free-entered Event the catalog never heard of parks and wakes the same
    // way: the name and the match are all resume matching ever reads.
    it("wakes on an undeclared Event name with a match", async () => {
      const result = await resumeWaitsMatchingEvent({
        workflowId: "workflow_1",
        eventType: "vendor/never.declared",
        payload: { ref: "abc" },
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [
              {
                event: "vendor/never.declared",
                match: {
                  expression: 'payload.ref == "abc"',
                  timestampPaths: [],
                },
              },
            ],
          }),
        ],
      });

      expect(result).toBe(1);
    });

    // A payload delivers a timestamp as an ISO string, and CEL has no overload
    // comparing a string to an instant, so the paths the model marked travel
    // beside the expression and are decoded before it runs.
    it("compares a timestamp field the model marked", async () => {
      const subscriptions = [
        {
          event: "billing/payment.settled",
          match: {
            expression: 'payload.settledAt < date("2026-07-01T00:00:00.000Z")',
            timestampPaths: ["settledAt"],
          },
        },
      ];

      const before = await resumeWaitsMatchingEvent({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { settledAt: "2026-06-30T12:00:00.000Z" },
        waitStates: [createWaitState("1", "exec_1", { subscriptions })],
      });
      expect(before).toBe(1);

      vi.clearAllMocks();
      markWaitStateStatusMock.mockResolvedValue(true);

      const after = await resumeWaitsMatchingEvent({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { settledAt: "2026-07-02T12:00:00.000Z" },
        waitStates: [createWaitState("2", "exec_2", { subscriptions })],
      });
      expect(after).toBe(0);
    });

    // The payload arrived from outside and may carry anything, so a field of the
    // wrong shape is a payload that does not satisfy the match.
    it("does not wake a run when the match fails to evaluate", async () => {
      const result = await resumeWaitsMatchingEvent({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { appointmentId: { nested: "object" } },
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [
              {
                event: "billing/payment.settled",
                match: {
                  expression: 'payload.appointmentId.contains("appt")',
                  timestampPaths: [],
                },
              },
            ],
          }),
        ],
      });

      expect(result).toBe(0);
      expect(sendWorkflowWaitSignalMock).not.toHaveBeenCalled();
    });

    it("reads only the subscriptions naming the arriving Event", async () => {
      const result = await resumeWaitsMatchingEvent({
        workflowId: "workflow_1",
        eventType: "app/appointment.confirmed",
        payload: { id: "no" },
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [
              {
                event: "app/appointment.confirmed",
                match: {
                  expression: 'payload.id == "yes"',
                  timestampPaths: [],
                },
              },
              // Satisfied by this payload, and irrelevant: a different Event.
              { event: "app/appointment.canceled" },
            ],
          }),
        ],
      });

      expect(result).toBe(0);
    });
  });
});
