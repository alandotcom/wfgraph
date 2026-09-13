import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InngestClient,
  InngestError,
} from "#src/backend/lib/effect/inngest-client";
import {
  makeRecordingLogger,
  stubExecutionRepo,
  stubInngestClient,
} from "#src/backend/lib/effect/test-layers";
import type {
  ExecutionRepo,
  WorkflowWaitState,
} from "#src/backend/services/executions/repo";
import {
  signalParkedWaits,
  wakeParkedWaitsAfterExit,
} from "#src/backend/services/workflows/lifecycle/signal-parked-waits";

type Repo = ExecutionRepo["Service"];

const listActiveWaitStatesMock = vi.fn<Repo["listActiveWaitStates"]>(() =>
  Effect.succeed([])
);
const sendWaitSignalMock = vi.fn<InngestClient["Service"]["sendWaitSignal"]>(
  () => Effect.void
);

const services = Layer.mergeAll(
  stubExecutionRepo({ listActiveWaitStates: listActiveWaitStatesMock }),
  stubInngestClient({ sendWaitSignal: sendWaitSignalMock })
);

/** A Wait an Execution is parked on, as the repository hands one over. */
function parkedWait(
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

const threeWaits = [
  parkedWait(),
  parkedWait({ id: "wait_2", nodeId: "node_wait_2", resumeToken: "token_2" }),
  parkedWait({
    id: "wait_3",
    nodeId: "node_delay",
    waitType: "delay",
    resumeToken: null,
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  listActiveWaitStatesMock.mockReturnValue(Effect.succeed([]));
  sendWaitSignalMock.mockReturnValue(Effect.void);
});

describe("signalParkedWaits", () => {
  it("sends one signal per parked Wait, addressed by that Wait's node and token", async () => {
    await Effect.runPromise(
      signalParkedWaits({
        executionId: "exec_1",
        parked: threeWaits,
        signalType: "lifecycle-exit",
      }).pipe(Effect.provide(services))
    );

    expect(sendWaitSignalMock.mock.calls.map(([signal]) => signal)).toEqual([
      {
        executionId: "exec_1",
        nodeId: "node_wait",
        token: "token_1",
        signalType: "lifecycle-exit",
      },
      {
        executionId: "exec_1",
        nodeId: "node_wait_2",
        token: "token_2",
        signalType: "lifecycle-exit",
      },
      {
        executionId: "exec_1",
        nodeId: "node_delay",
        token: null,
        signalType: "lifecycle-exit",
      },
    ]);
  });

  // One refused send must not leave the other Waits parked, so every send is
  // made before the refusal is reported.
  it("attempts every Wait before failing with the refusal", async () => {
    const refusal = new InngestError({ cause: new Error("bus refused") });
    sendWaitSignalMock.mockImplementation((signal) =>
      signal.nodeId === "node_wait" ? Effect.fail(refusal) : Effect.void
    );

    const failure = await Effect.runPromise(
      Effect.flip(
        signalParkedWaits({
          executionId: "exec_1",
          parked: threeWaits,
          signalType: "lifecycle-exit",
        }).pipe(Effect.provide(services))
      )
    );

    expect(failure).toBe(refusal);
    expect(sendWaitSignalMock).toHaveBeenCalledTimes(3);
  });
});

describe("wakeParkedWaitsAfterExit", () => {
  it("signals every Wait the Execution still has parked and records the count", async () => {
    listActiveWaitStatesMock.mockReturnValue(Effect.succeed(threeWaits));
    const recorder = makeRecordingLogger();

    await Effect.runPromise(
      wakeParkedWaitsAfterExit({ executionId: "exec_1" }).pipe(
        Effect.provide(Layer.mergeAll(services, recorder.layer))
      )
    );

    expect(listActiveWaitStatesMock).toHaveBeenCalledWith("exec_1");
    expect(sendWaitSignalMock).toHaveBeenCalledTimes(3);
    expect(
      sendWaitSignalMock.mock.calls.every(
        ([signal]) => signal.signalType === "lifecycle-exit"
      )
    ).toBe(true);
    expect(recorder.infoLines).toEqual([
      {
        message: "Woke the parked Waits of an exited run",
        properties: {
          run: { executionId: "exec_1" },
          outcome: { parkedWaits: 3 },
        },
      },
    ]);
  });

  // A resume producer holds this row while its own signal is in flight. If that
  // send fails, the release returns the row to waiting after the Exit claim has
  // already refused every later resume, so the Exit wake signals the row now.
  it("signals a Wait whose row a resume producer holds, with that row's token", async () => {
    listActiveWaitStatesMock.mockReturnValue(
      Effect.succeed([
        parkedWait({
          status: "resuming",
          resumeToken: "token_claimed",
          resumedAt: new Date("2026-03-02T00:00:00.000Z"),
        }),
      ])
    );

    await Effect.runPromise(
      wakeParkedWaitsAfterExit({ executionId: "exec_1" }).pipe(
        Effect.provide(Layer.mergeAll(services, makeRecordingLogger().layer))
      )
    );

    expect(sendWaitSignalMock.mock.calls.map(([signal]) => signal)).toEqual([
      {
        executionId: "exec_1",
        nodeId: "node_wait",
        token: "token_claimed",
        signalType: "lifecycle-exit",
      },
    ]);
  });
});
