import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InngestClient,
  InngestError,
} from "#src/backend/lib/effect/inngest-client";
import type { AppLogger } from "#src/backend/lib/effect/app-logger";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import type {
  ExecutionRepo,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import { requestCanceledOutlet } from "#src/backend/services/workflows/lifecycle/cancel";

type Repo = ExecutionRepo["Service"];

const requestCancelForEntityMock = vi.fn<Repo["requestCancelForEntity"]>(() =>
  Effect.succeed(["exec_1"])
);
const listWaitingStatesForExecutionsMock = vi.fn<
  Repo["listWaitingStatesForExecutions"]
>(() => Effect.succeed(new Map()));
const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);
const sendWaitSignalMock = vi.fn<InngestClient["Service"]["sendWaitSignal"]>(
  () => Effect.void
);
const sendBranchKillMock = vi.fn<InngestClient["Service"]["sendBranchKill"]>(
  () => Effect.void
);

const services = Layer.mergeAll(
  stubExecutionRepo({
    requestCancelForEntity: requestCancelForEntityMock,
    listWaitingStatesForExecutions: listWaitingStatesForExecutionsMock,
    recordAuditEvent: recordAuditEventMock,
  }),
  stubInngestClient({
    sendWaitSignal: sendWaitSignalMock,
    sendBranchKill: sendBranchKillMock,
  })
);

/** A run parked on a wait, as the batched read hands one over. */
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

function cancel(
  overrides: Partial<typeof cancelInput> = {},
  loggerLayer: Layer.Layer<AppLogger> = SilentAppLoggerLayer
) {
  return Effect.runPromise(
    requestCanceledOutlet({ ...cancelInput, ...overrides }).pipe(
      Effect.provide(Layer.mergeAll(services, loggerLayer))
    )
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requestCancelForEntityMock.mockReturnValue(Effect.succeed(["exec_1"]));
  listWaitingStatesForExecutionsMock.mockReturnValue(Effect.succeed(new Map()));
  recordAuditEventMock.mockReturnValue(Effect.void);
  sendWaitSignalMock.mockReturnValue(Effect.void);
  sendBranchKillMock.mockReturnValue(Effect.void);
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
    listWaitingStatesForExecutionsMock.mockReturnValue(
      Effect.succeed(
        new Map([
          [
            "exec_1",
            [
              createWaitState(),
              createWaitState({
                id: "wait_2",
                nodeId: "node_wait_2",
                resumeToken: "token_2",
              }),
            ],
          ],
        ])
      )
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

  /**
   * The work behind a Wait runs in an invocation of its own, which nothing on
   * the run's own row reaches. The kill is what ends it, and it names the
   * Execution rather than the branch, so one send ends every branch at once and
   * the sweep that follows closes nothing still going.
   */
  it("kills the branch invocations of every claimed run", async () => {
    requestCancelForEntityMock.mockReturnValue(
      Effect.succeed(["exec_1", "exec_2"])
    );

    await cancel();

    expect(sendBranchKillMock).toHaveBeenCalledTimes(2);
    expect(sendBranchKillMock).toHaveBeenCalledWith({
      executionId: "exec_1",
      workflowId: "wf_1",
      reason: "Cancellation requested by app/appointment.canceled",
    });
  });

  it("asks nothing further when the entity has no run in flight", async () => {
    requestCancelForEntityMock.mockReturnValue(Effect.succeed([]));

    const claimed = await cancel();

    expect(claimed).toEqual([]);
    expect(listWaitingStatesForExecutionsMock).not.toHaveBeenCalled();
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  // The flag is the authority and it is already written, so the run reaches its
  // Canceled outlet whether or not the nudge landed.
  it("keeps a flagged run on the list when its nudge fails", async () => {
    listWaitingStatesForExecutionsMock.mockReturnValue(
      Effect.succeed(new Map([["exec_1", [createWaitState()]]]))
    );
    sendWaitSignalMock.mockReturnValue(
      Effect.fail(new InngestError({ cause: new Error("bus refused") }))
    );
    const recorder = makeRecordingLogger();

    const claimed = await cancel({}, recorder.layer);

    expect(claimed).toEqual(["exec_1"]);
    expect(recorder.lines).toHaveLength(1);
  });

  // The flag is written and `requestCancelForEntity` refuses to re-claim a run it
  // already flagged, so raising here would leave the claimed runs asleep until
  // their wait timeout with no retry able to reach them.
  it("still claims the runs when their waits cannot be read", async () => {
    requestCancelForEntityMock.mockReturnValue(
      Effect.succeed(["exec_1", "exec_2"])
    );
    listWaitingStatesForExecutionsMock.mockReturnValue(
      Effect.fail(new DatabaseError({ cause: new Error("connection reset") }))
    );
    const recorder = makeRecordingLogger();

    const claimed = await cancel({}, recorder.layer);

    expect(claimed).toEqual(["exec_1", "exec_2"]);
    expect(sendWaitSignalMock).not.toHaveBeenCalled();
    expect(recorder.lines).toHaveLength(1);
  });

  // One read for the whole claimed set, rather than one per run.
  it("asks for every claimed run's waits in one read", async () => {
    requestCancelForEntityMock.mockReturnValue(
      Effect.succeed(["exec_1", "exec_2"])
    );

    await cancel();

    expect(listWaitingStatesForExecutionsMock).toHaveBeenCalledTimes(1);
    expect(listWaitingStatesForExecutionsMock).toHaveBeenCalledWith([
      "exec_1",
      "exec_2",
    ]);
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
