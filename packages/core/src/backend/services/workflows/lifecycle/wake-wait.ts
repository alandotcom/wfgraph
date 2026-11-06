import { Effect } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { ExecutionDriver } from "#src/backend/services/executions/driver";

/**
 * Which parked Wait the wake addresses, as `ParkTarget` in `driver.ts`
 * describes, with the delivery that carried an Event.
 */
type WaitWakeTarget =
  | { kind: "resume_token"; token: string }
  | {
      kind: "wait_state";
      waitStateId: string;
      token: string;
      eventName: string;
      deliveryId?: string | undefined;
      /** Permit only an empty arrival slot or this arrival's own delivery id. */
      allowSameDeliveryRetry?: boolean | undefined;
    };

/**
 * How far a wake got. `unclaimed` is no row this wake could take, so no run
 * woke. `resumed` is the park claimed and resolved with this wake, and its run
 * re-queued, which the next pass of the run acts on.
 */
export type WaitWakeOutcome =
  | { status: "unclaimed" }
  | { status: "resumed"; executionId: string };

/**
 * Claims one event park for an Event or a manual resume, and resolves it with
 * the arrival in the same write.
 *
 * The run's next pass reads the wake from the row, so it owns the Execution's
 * running status, the timeline entry for the wake, and closing the row.
 */
export const wakeWait = Effect.fn("wakeWait")(function* (input: {
  target: WaitWakeTarget;
  /** What the Event or the Runs view sent, which the woken run reads back. */
  payload: JsonObject;
}) {
  const driver = yield* ExecutionDriver;
  const { target, payload } = input;
  const claim = yield* driver.resolvePark({
    target,
    arrival: {
      signalType: "wait-resume",
      eventName: target.kind === "wait_state" ? target.eventName : null,
      payload,
      deliveryId: target.kind === "wait_state" ? target.deliveryId : undefined,
    },
  });

  if (!claim) {
    const unclaimed: WaitWakeOutcome = { status: "unclaimed" };
    return unclaimed;
  }
  const resumed: WaitWakeOutcome = {
    status: "resumed",
    executionId: claim.waitState.executionId,
  };
  return resumed;
});
