/**
 * A Cancel Event, routed to the runs it concerns.
 *
 * ADR-0007 keeps the run itself alive, so a cancellation is a routed
 * continuation: the authority is a claim on the execution row, and the run
 * reads it at its next `lifecycle-check` step and enters its Canceled outlet
 * with every landed node output intact. The claim resolves the run's parked
 * Waits with a `cancel` wake in the same write, so a parked run is re-queued
 * and its next pass halts those Waits and routes the outlet.
 */

import { Effect } from "effect";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import type { ExecutionEntitySelector } from "#src/backend/services/executions/repo";
import type { JsonObject } from "@wfgraph/shared/types/json";

/**
 * Claims every in-flight run of this workflow about this entity for the Canceled
 * outlet, answering the ids claimed, including those an earlier attempt of the
 * same delivery claimed.
 *
 * The ids come back so the delivery can keep the same Event off those runs'
 * waits: they are ending, and waking one would resume a run on its way out.
 * The claim records its decision for this delivery, and each claimed run's
 * timeline entry, in its own transaction, so a retried delivery claims no run
 * that opened since and records nothing twice.
 */
export const requestCanceledOutlet = Effect.fn(
  "wfgraph.execution.request_canceled_outlet"
)(function* (
  input: {
    workflowId: string;
    eventName: string;
    payload: JsonObject;
    /** The arrival's inbox id. */
    deliveryId: string;
  } & ExecutionEntitySelector
) {
  const driver = yield* ExecutionDriver;
  const claims = yield* driver.requestCanceledOutlet(input);
  return claims.map((claim) => claim.executionId);
});
