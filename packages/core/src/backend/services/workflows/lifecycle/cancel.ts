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
import { DEFAULT_QUERY_CONNECTIONS } from "#src/backend/lib/db/config";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import {
  type CanceledOutletClaim,
  ExecutionRepo,
  type ExecutionEntitySelector,
} from "#src/backend/services/executions/repo";
import type { JsonObject } from "@wfgraph/shared/types/json";
import type { WorkflowMode } from "@wfgraph/shared/graph/types";

/**
 * Claims every in-flight run of this workflow about this entity for the Canceled
 * outlet, answering the ids claimed.
 *
 * The ids come back so the delivery can keep the same Event off those runs'
 * waits: they are ending, and waking one would resume a run on its way out.
 */
export const requestCanceledOutlet = Effect.fn("requestCanceledOutlet")(
  function* (
    input: {
      workflowId: string;
      runMode: WorkflowMode;
      eventName: string;
      payload: JsonObject;
    } & ExecutionEntitySelector
  ) {
    const driver = yield* ExecutionDriver;

    const claims = yield* driver.requestCanceledOutlet(input);

    yield* Effect.forEach(
      claims,
      (claim) =>
        recordCancelRequested({
          workflowId: input.workflowId,
          eventName: input.eventName,
          claim,
        }),
      { concurrency: DEFAULT_QUERY_CONNECTIONS }
    );

    return claims.map((claim) => claim.executionId);
  }
);

/**
 * Records one claim on its run's timeline. The claim has already landed, so a
 * refused write is logged and the other claimed runs are still recorded.
 */
const recordCancelRequested = Effect.fn("recordCancelRequested")(
  function* (input: {
    workflowId: string;
    eventName: string;
    claim: CanceledOutletClaim;
  }) {
    const repo = yield* ExecutionRepo;
    const logger = (yield* AppLogger).get("lifecycle-cancel");
    const { executionId, resolvedParks } = input.claim;

    yield* repo
      .recordAuditEvent({
        workflowId: input.workflowId,
        executionId,
        eventType: "run_cancel_requested",
        message: `Cancellation requested by ${input.eventName}`,
        metadata: {
          eventName: input.eventName,
          parkedWaits: resolvedParks,
        },
      })
      .pipe(
        Effect.catch((error) =>
          logger.error("Failed to record a cancellation request", {
            workflowId: input.workflowId,
            executionId,
            eventName: input.eventName,
            error,
          })
        )
      );
  }
);
