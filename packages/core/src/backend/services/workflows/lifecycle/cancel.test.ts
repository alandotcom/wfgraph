import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InngestClient,
  InngestError,
} from "#src/backend/lib/effect/inngest-client";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import type {
  ExecutionRepo,
  WorkflowWaitState,
} from "#src/backend/services/workflows/executions/repo/index";
import { requestCanceledOutlet } from "./cancel";

const { loggerErrorMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
}));

// Two cases below are about what a contained failure leaves behind rather than
// about what is returned, and the log line is where that lands.
vi.mock("#src/backend/lib/logger", () => ({
  getAppLogger: () => ({
    error: loggerErrorMock,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

type Repo = ExecutionRepo["Service"];

const requestCancelForEntityMock = vi.fn<Repo["requestCancelForEntity"]>(() =>
  Effect.succeed(["exec_1"])
);
const listWaitingStatesMock = vi.fn<Repo["listWaitingStates"]>(() =>
  Effect.succeed([])
);
const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const sendWaitSignalMock = vi.fn<InngestClient["Service"]["sendWaitSignal"]>(
  () => Effect.void
);

const services = Layer.mergeAll(
  stubExecutionRepo({
    requestCancelForEntity: requestCancelForEntityMock,
    listWaitingStates: listWaitingStatesMock,
    recordAuditEvent: recordAuditEventMock,
  }),
  stubInngestClient({ sendWaitSignal: sendWaitSignalMock })
);

/** A run parked on a wait, as `listWaitingStates` hands one over. */
function createWaitState(
  overrides: Partial<WorkflowWaitState> = {}
): WorkflowWaitState {
  return {
    id: "wait_1",
    executionId: "exec_1",
    workflowId: "wf_1",
    runId: "run_1",
    nodeId: "node_wait",
    nodeName: "Wait for confirmation",
    waitType: "event",
    status: "waiting",
    resumeToken: "token_1",
    waitUntil: null,
    subscribedEvents: ["app/appointment.confirmed"],
    metadata: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    resumedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

const cancelInput = {
  workflowId: "wf_1",
  runMode: "live" as const,
  eventName: "app/appointment.canceled",
  payload: { appointment: { id: "appt_8813" }, reason: "patient called" },
  entityValue: "appt_8813",
};

function cancel(overrides: Partial<typeof cancelInput> = {}) {
  return Effect.runPromise(
    requestCanceledOutlet({ ...cancelInput, ...overrides }).pipe(
      Effect.provide(services)
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requestCancelForEntityMock.mockReturnValue(Effect.succeed(["exec_1"]));
  listWaitingStatesMock.mockReturnValue(Effect.succeed([]));
  recordAuditEventMock.mockReturnValue(Effect.void);
  sendWaitSignalMock.mockReturnValue(Effect.void);
});

describe("requestCanceledOutlet", () => {
  it("flags the in-flight runs about this entity", async () => {
    const claimed = await cancel();

    expect(claimed).toEqual(["exec_1"]);
    expect(requestCancelForEntityMock).toHaveBeenCalledWith({
      workflowId: "wf_1",
      entityValue: "appt_8813",
      runMode: "live",
      eventName: "app/appointment.canceled",
      payload: cancelInput.payload,
    });
  });

  // A parked run is reaching no step boundary, so the flag alone would leave it
  // asleep until its wait timed out.
  it("nudges every wait a flagged run is parked on", async () => {
    listWaitingStatesMock.mockReturnValue(
      Effect.succeed([
        createWaitState(),
        createWaitState({
          id: "wait_2",
          nodeId: "node_wait_2",
          resumeToken: "token_2",
        }),
      ])
    );

    await cancel();

    expect(sendWaitSignalMock).toHaveBeenCalledTimes(2);
    expect(sendWaitSignalMock).toHaveBeenCalledWith({
      executionId: "exec_1",
      nodeId: "node_wait",
      token: "token_1",
      eventType: "app/appointment.canceled",
      payload: cancelInput.payload,
      signalType: "lifecycle-cancel",
    });
  });

  // A running run reads the flag at its next node boundary, so there is nothing
  // to wake and nothing to send.
  it("sends no signal for a run standing on no wait", async () => {
    const claimed = await cancel();

    expect(claimed).toEqual(["exec_1"]);
    expect(sendWaitSignalMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).toHaveBeenCalledTimes(1);
  });

  it("asks nothing further when the entity has no run in flight", async () => {
    requestCancelForEntityMock.mockReturnValue(Effect.succeed([]));

    const claimed = await cancel();

    expect(claimed).toEqual([]);
    expect(listWaitingStatesMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  // The flag is the authority and it is already written, so the run reaches its
  // Canceled outlet whether or not the nudge landed.
  it("keeps a flagged run on the list when its nudge fails", async () => {
    listWaitingStatesMock.mockReturnValue(Effect.succeed([createWaitState()]));
    sendWaitSignalMock.mockReturnValue(
      Effect.fail(new InngestError({ cause: new Error("bus refused") }))
    );

    const claimed = await cancel();

    expect(claimed).toEqual(["exec_1"]);
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
  });

  it("wakes the other flagged runs when one of them cannot be read", async () => {
    requestCancelForEntityMock.mockReturnValue(
      Effect.succeed(["exec_1", "exec_2"])
    );
    listWaitingStatesMock.mockImplementation((executionId) =>
      executionId === "exec_1"
        ? Effect.fail(
            new DatabaseError({ cause: new Error("connection reset") })
          )
        : Effect.succeed([
            createWaitState({ id: "wait_2", executionId: "exec_2" }),
          ])
    );

    const claimed = await cancel();

    expect(claimed).toEqual(["exec_1", "exec_2"]);
    expect(sendWaitSignalMock).toHaveBeenCalledTimes(1);
    expect(sendWaitSignalMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "exec_2" })
    );
  });

  // A refused write is not a verdict: nothing was flagged, so the delivery keeps
  // failing and is retried rather than reporting a cancellation that did not run.
  it("leaves a refused flag write failing", async () => {
    requestCancelForEntityMock.mockReturnValue(
      Effect.fail(new DatabaseError({ cause: new Error("write refused") }))
    );

    await expect(cancel()).rejects.toThrow();
  });
});
