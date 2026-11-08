import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubExecutionDriver } from "#src/backend/lib/effect/test-layers";
import {
  DriverError,
  type ExecutionDriver,
} from "#src/backend/services/executions/driver";
import type { CanceledOutletClaim } from "#src/backend/services/executions/repo";
import { requestCanceledOutlet } from "#src/backend/services/workflows/lifecycle/cancel";

/** A run the Cancel claim took, with the parks the claim resolved. */
function claim(executionId: string, resolvedParks = 0): CanceledOutletClaim {
  return {
    kind: "claimed",
    executionId,
    resolvedParks,
    requeued: resolvedParks > 0,
  };
}

const requestCanceledOutletMock = vi.fn<
  ExecutionDriver["Service"]["requestCanceledOutlet"]
>(() => Effect.succeed([claim("exec_1")]));

const cancelInput = {
  workflowId: "wf_1",
  eventName: "app/appointment.canceled",
  payload: { appointment: { id: "appt_8813" }, reason: "patient called" },
  deliveryId: "inbox_1",
  entityValue: "appt_8813",
};

function cancel() {
  return Effect.runPromise(
    requestCanceledOutlet(cancelInput).pipe(
      Effect.provide(
        stubExecutionDriver({
          requestCanceledOutlet: requestCanceledOutletMock,
        })
      )
    )
  );
}

beforeEach(() => {
  requestCanceledOutletMock.mockReset();
  requestCanceledOutletMock.mockReturnValue(Effect.succeed([claim("exec_1")]));
});

describe("requestCanceledOutlet", () => {
  it("claims the in-flight runs about this entity under the arrival's delivery id", async () => {
    const claimed = await cancel();

    expect(claimed).toEqual(["exec_1"]);
    expect(requestCanceledOutletMock).toHaveBeenCalledWith(cancelInput);
  });

  // A retried delivery's claim flags nothing new and names the runs the first
  // attempt claimed, which the delivery keeps the same Event off.
  it("answers the runs an earlier attempt of the delivery claimed", async () => {
    requestCanceledOutletMock.mockReturnValue(
      Effect.succeed([
        claim("exec_1", 2),
        { kind: "claimed_earlier", executionId: "exec_2" },
      ])
    );

    expect(await cancel()).toEqual(["exec_1", "exec_2"]);
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
