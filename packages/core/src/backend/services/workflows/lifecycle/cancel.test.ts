import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppLogger } from "#src/backend/lib/effect/app-logger";
import { DatabaseError } from "#src/backend/lib/effect/database";
import {
  makeRecordingLogger,
  SilentAppLoggerLayer,
  stubExecutionDriver,
  stubExecutionRepo,
} from "#src/backend/lib/effect/test-layers";
import {
  DriverError,
  type ExecutionDriver,
} from "#src/backend/services/executions/driver";
import type {
  CanceledOutletClaim,
  ExecutionRepo,
} from "#src/backend/services/executions/repo";
import { requestCanceledOutlet } from "#src/backend/services/workflows/lifecycle/cancel";

type Repo = ExecutionRepo["Service"];

/** A run the Cancel claim took, with the parks the claim resolved. */
function claim(executionId: string, resolvedParks = 0): CanceledOutletClaim {
  return { executionId, resolvedParks, requeued: resolvedParks > 0 };
}

const requestCanceledOutletMock = vi.fn<
  ExecutionDriver["Service"]["requestCanceledOutlet"]
>(() => Effect.succeed([claim("exec_1")]));
const recordAuditEventMock = vi.fn<Repo["recordAuditEvent"]>(() => Effect.void);

const services = Layer.mergeAll(
  stubExecutionRepo({ recordAuditEvent: recordAuditEventMock }),
  stubExecutionDriver({ requestCanceledOutlet: requestCanceledOutletMock })
);

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
  requestCanceledOutletMock.mockReset();
  recordAuditEventMock.mockReset();
  requestCanceledOutletMock.mockReturnValue(Effect.succeed([claim("exec_1")]));
  recordAuditEventMock.mockReturnValue(Effect.void);
});

describe("requestCanceledOutlet", () => {
  it("claims the in-flight runs about this entity", async () => {
    const claimed = await cancel();

    expect(claimed).toEqual(["exec_1"]);
    expect(requestCanceledOutletMock).toHaveBeenCalledWith({
      workflowId: "wf_1",
      entityValue: "appt_8813",
      runMode: "live",
      eventName: "app/appointment.canceled",
      payload: cancelInput.payload,
    });
  });

  // The claim resolves a parked run's Waits with a `cancel` wake in the same
  // write, so the timeline entry names how many parks it woke.
  it("records each claimed run with the parks its claim woke", async () => {
    requestCanceledOutletMock.mockReturnValue(
      Effect.succeed([claim("exec_1", 2), claim("exec_2")])
    );

    const claimed = await cancel();

    expect(claimed).toEqual(["exec_1", "exec_2"]);
    expect(recordAuditEventMock).toHaveBeenCalledTimes(2);
    expect(recordAuditEventMock).toHaveBeenCalledWith({
      workflowId: "wf_1",
      executionId: "exec_1",
      eventType: "run_cancel_requested",
      message: "Cancellation requested by app/appointment.canceled",
      metadata: {
        eventName: "app/appointment.canceled",
        parkedWaits: 2,
      },
    });
  });

  it("records nothing when the entity has no run in flight", async () => {
    requestCanceledOutletMock.mockReturnValue(Effect.succeed([]));

    const claimed = await cancel();

    expect(claimed).toEqual([]);
    expect(recordAuditEventMock).not.toHaveBeenCalled();
  });

  // The claim has landed and is the authority, so a timeline write the
  // database refused is logged and every claimed run is still answered.
  it("keeps a claimed run on the list when its timeline entry fails", async () => {
    requestCanceledOutletMock.mockReturnValue(
      Effect.succeed([claim("exec_1"), claim("exec_2")])
    );
    recordAuditEventMock.mockReturnValueOnce(
      Effect.fail(new DatabaseError({ cause: new Error("write refused") }))
    );
    const recorder = makeRecordingLogger();

    const claimed = await cancel({}, recorder.layer);

    expect(claimed).toEqual(["exec_1", "exec_2"]);
    expect(recordAuditEventMock).toHaveBeenCalledTimes(2);
    expect(recorder.lines).toHaveLength(1);
  });

  // A refused claim is not a verdict: nothing was claimed, so the delivery
  // keeps failing and is retried rather than reporting a cancellation that did
  // not run.
  it("leaves a refused claim failing", async () => {
    requestCanceledOutletMock.mockReturnValue(
      Effect.fail(new DriverError({ cause: new Error("write refused") }))
    );

    await expect(cancel()).rejects.toThrow();
  });
});
