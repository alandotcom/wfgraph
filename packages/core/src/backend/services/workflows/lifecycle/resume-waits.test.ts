import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppLogger } from "#src/backend/lib/effect/app-logger";
import {
  InngestError,
  type InngestClient,
} from "#src/backend/lib/effect/inngest-client";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import { getAppLogger } from "#src/backend/lib/logger";
import type { ExecutionRepo } from "#src/backend/services/executions/repo";
import { resumeWaitsMatchingEvent } from "#src/backend/services/workflows/lifecycle/resume-waits";

const { loggerErrorMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
}));

type Repo = ExecutionRepo["Service"];

const sendWaitSignalMock = vi.fn<InngestClient["Service"]["sendWaitSignal"]>(
  () => Effect.void
);
const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const markRunningMock = vi.fn<Repo["markRunning"]>(() => Effect.succeed(true));
const markWaitStatusMock = vi.fn<Repo["markWaitStatus"]>(() =>
  Effect.succeed(true)
);

const services = Layer.mergeAll(
  stubExecutionRepo({
    recordAuditEvent: recordAuditEventMock,
    markRunning: markRunningMock,
    markWaitStatus: markWaitStatusMock,
  }),
  stubInngestClient({ sendWaitSignal: sendWaitSignalMock })
);

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

/**
 * The subject on its stub services.
 *
 * Every case sends and writes through the same stubs, so only what varies is
 * written at a call site. The logger defaults to silent; a case that asserts
 * on a log line hands over `makeRecordingLogger().layer` instead.
 */
function resumeWaits(
  input: Parameters<typeof resumeWaitsMatchingEvent>[0],
  loggerLayer: Layer.Layer<AppLogger> = SilentAppLoggerLayer
): Promise<number> {
  return Effect.runPromise(
    resumeWaitsMatchingEvent(input).pipe(
      Effect.provide(Layer.mergeAll(services, loggerLayer))
    )
  );
}

describe("resumeWaitsMatchingEvent", () => {
  beforeEach(() => {
    loggerErrorMock.mockReset();
    sendWaitSignalMock.mockReset();
    markWaitStatusMock.mockReset();
    markRunningMock.mockReset();
    recordAuditEventMock.mockReset();

    // `wait-match` captured the logger at module load, so spy the same category
    // instance's `error` rather than replacing `getAppLogger`. This module's
    // own logging goes through the `AppLogger` service, silenced below.
    const waitMatchLogger = getAppLogger("workflow", "wait-match");
    vi.spyOn(waitMatchLogger, "error").mockImplementation(((
      message: string
    ) => {
      loggerErrorMock(message);
    }) as typeof waitMatchLogger.error);

    sendWaitSignalMock.mockImplementation(() => Effect.void);
    markWaitStatusMock.mockImplementation(() => Effect.succeed(true));
    markRunningMock.mockImplementation(() => Effect.succeed(true));
    recordAuditEventMock.mockImplementation(() => Effect.void);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 0 when eventType is undefined", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: undefined,
      payload: { data: "test" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(sendWaitSignalMock).not.toHaveBeenCalled();
  });

  it("returns 0 when eventType is empty string", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "",
      payload: { data: "test" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(sendWaitSignalMock).not.toHaveBeenCalled();
  });

  it("returns 0 for empty waitStates array", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { data: "test" },
      waitStates: [],
    });

    expect(result).toBe(0);
  });

  // A row with no token can never be woken by an Event, so it is a defect in
  // whatever wrote it.
  it("skips wait states without a resume token", async () => {
    const recorder = makeRecordingLogger();

    const result = await resumeWaits(
      {
        workflowId: "workflow_1",
        eventType: "event.update",
        payload: { data: "test" },
        waitStates: [
          createWaitState("1", "exec_1", { resumeToken: null }),
          createWaitState("2", "exec_2", { resumeToken: null }),
        ],
      },
      recorder.layer
    );

    expect(result).toBe(0);
    expect(sendWaitSignalMock).not.toHaveBeenCalled();
    expect(recorder.warnLines).toHaveLength(2);
    expect(recorder.warnLines[0]).toEqual({
      message: "Parked wait carries no resume token",
      properties: expect.objectContaining({
        waitStateId: "1",
        executionId: "exec_1",
      }),
    });
  });

  it("resumes a match-free subscription on the next occurrence", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: { key: "value" },
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(1);
    expect(sendWaitSignalMock).toHaveBeenCalledTimes(1);
    expect(sendWaitSignalMock).toHaveBeenCalledWith({
      executionId: "exec_1",
      nodeId: "node_1",
      token: "token_1",
      eventType: "event.update",
      payload: { key: "value" },
      signalType: "wait-resume",
    });
    expect(markWaitStatusMock).toHaveBeenCalledWith({
      waitStateId: "1",
      status: "resumed",
    });
    expect(markRunningMock).toHaveBeenCalledWith("exec_1");
    expect(recordAuditEventMock).toHaveBeenCalledTimes(1);
  });

  it("resumes multiple wait states and returns total count", async () => {
    const result = await resumeWaits({
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
    expect(sendWaitSignalMock).toHaveBeenCalledTimes(3);
    expect(markWaitStatusMock).toHaveBeenCalledTimes(3);
    expect(markRunningMock).toHaveBeenCalledTimes(3);
  });

  it("wakes nothing for a row whose metadata holds no subscriptions", async () => {
    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [
        { ...createWaitState("1", "exec_1"), metadata: null },
        { ...createWaitState("2", "exec_2"), metadata: {} },
      ],
    });

    expect(result).toBe(0);
    expect(sendWaitSignalMock).not.toHaveBeenCalled();
  });

  // A candidate row reached the matcher because its own `subscribed_events`
  // named this Event, so a `waitFor` that will not decode is a row this engine
  // wrote and cannot read. Silently, it looks exactly like an ordinary no-match.
  it("says so when a parked row's subscriptions will not decode", async () => {
    const result = await resumeWaits({
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
    expect(sendWaitSignalMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Parked wait holds subscriptions that will not decode"
    );
  });

  it("returns 0 for a wait state when the wait row had already moved on", async () => {
    markWaitStatusMock.mockImplementation(() => Effect.succeed(false));

    const result = await resumeWaits({
      workflowId: "workflow_1",
      eventType: "event.update",
      payload: {},
      waitStates: [createWaitState("1", "exec_1")],
    });

    expect(result).toBe(0);
    expect(sendWaitSignalMock).toHaveBeenCalledTimes(1);
    expect(markWaitStatusMock).toHaveBeenCalledTimes(1);
    expect(markRunningMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  it("counts 0 for failed resumes and continues processing others", async () => {
    sendWaitSignalMock
      .mockImplementationOnce(() => Effect.void)
      .mockImplementationOnce(() =>
        Effect.fail(new InngestError({ cause: "signal failed" }))
      )
      .mockImplementationOnce(() => Effect.void);

    const result = await resumeWaits({
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
    expect(sendWaitSignalMock).toHaveBeenCalledTimes(3);
  });

  it("counts partial successes when some markWaitStateStatus return false", async () => {
    markWaitStatusMock
      .mockImplementationOnce(() => Effect.succeed(true))
      .mockImplementationOnce(() => Effect.succeed(false));

    const result = await resumeWaits({
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
    await resumeWaits({
      workflowId: "workflow_audit",
      eventType: "appointment.rescheduled",
      payload: { appointment: { id: "apt_1" } },
      waitStates: [
        createWaitState("1", "exec_1", {
          subscriptions: [{ event: "appointment.rescheduled" }],
        }),
      ],
    });

    expect(recordAuditEventMock).toHaveBeenCalledWith({
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

      const result = await resumeWaits({
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
      expect(sendWaitSignalMock).toHaveBeenCalledTimes(1);
      expect(sendWaitSignalMock).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: "exec_1" })
      );
    });

    // A rejection that wrote nothing leaves an operator with a count of zero
    // and no way to tell it from a row the candidate query never returned.
    it("wakes nothing when no arriving payload satisfies the match", async () => {
      const recorder = makeRecordingLogger();

      const result = await resumeWaits(
        {
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
        },
        recorder.layer
      );

      expect(result).toBe(0);
      expect(sendWaitSignalMock).not.toHaveBeenCalled();
      expect(recorder.debugLines).toHaveLength(1);
      expect(recorder.debugLines[0]?.message).toBe(
        "Wait match rejected an arrival"
      );
    });

    // A free-entered Event the catalog never heard of parks and wakes the same
    // way: the name and the match are all resume matching ever reads.
    it("wakes on an undeclared Event name with a match", async () => {
      const result = await resumeWaits({
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

      const before = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { settledAt: "2026-06-30T12:00:00.000Z" },
        waitStates: [createWaitState("1", "exec_1", { subscriptions })],
      });
      expect(before).toBe(1);

      vi.clearAllMocks();
      markWaitStatusMock.mockImplementation(() => Effect.succeed(true));

      const after = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload: { settledAt: "2026-07-02T12:00:00.000Z" },
        waitStates: [createWaitState("2", "exec_2", { subscriptions })],
      });
      expect(after).toBe(0);
    });

    // The timestamp decode writes a `Date` into whatever object holds the path,
    // so it runs against a copy. Sharing it would leave the second wait comparing
    // a `Date` where its own match, and every downstream template, expects the
    // ISO string the sender wrote.
    it("leaves the arriving payload as the sender wrote it", async () => {
      const payload = { settledAt: "2026-06-30T12:00:00.000Z" };

      const woken = await resumeWaits({
        workflowId: "workflow_1",
        eventType: "billing/payment.settled",
        payload,
        waitStates: [
          createWaitState("1", "exec_1", {
            subscriptions: [
              {
                event: "billing/payment.settled",
                match: {
                  expression:
                    'payload.settledAt < date("2026-07-01T00:00:00.000Z")',
                  timestampPaths: ["settledAt"],
                },
              },
            ],
          }),
          createWaitState("2", "exec_2", {
            subscriptions: [
              {
                event: "billing/payment.settled",
                match: {
                  expression: 'payload.settledAt == "2026-06-30T12:00:00.000Z"',
                  timestampPaths: [],
                },
              },
            ],
          }),
        ],
      });

      expect(woken).toBe(2);
      expect(payload.settledAt).toBe("2026-06-30T12:00:00.000Z");
    });

    // The payload arrived from outside and may carry anything, so a field of the
    // wrong shape is a payload that does not satisfy the match.
    it("does not wake a run when the match fails to evaluate", async () => {
      const result = await resumeWaits({
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
      expect(sendWaitSignalMock).not.toHaveBeenCalled();
    });

    it("reads only the subscriptions naming the arriving Event", async () => {
      const result = await resumeWaits({
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
