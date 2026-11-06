import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { catchStatedSeamFailures } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import type { JsonObject } from "@wfgraph/shared/types/json";

type WorkflowResumeSuccess = {
  success: true;
  status: "resumed";
  executionId: string;
};

/** This module's logger, as the Effect that produces it (see `workflow.ts`). */
const resumeLogger = Effect.map(AppLogger, (appLogger) =>
  appLogger.get("resume")
);

/**
 * Unparks one wait by its resume token, whatever the wait was subscribed to.
 *
 * The token is the whole of the address: no Event name and no match are consulted,
 * which is what makes this the way out for a run parked on an Event that will
 * never arrive. The Runs view reaches it through its authenticated RPC call.
 */
export const resumeWaitByToken = Effect.fn("resumeWaitByToken")(
  function* (input: { token: string; body: JsonObject }) {
    const driver = yield* ExecutionDriver;
    const claim = yield* driver.resolvePark({
      target: { kind: "resume_token", token: input.token },
      payload: input.body,
    });

    // A wake that claimed nothing is a wait the caller cannot reach.
    if (claim === null) {
      const logger = yield* resumeLogger;
      yield* logger.warn("Wait not found or no longer active");
      return yield* new NotFound({
        error: "Wait not found or no longer active",
      });
    }

    const resumed: WorkflowResumeSuccess = {
      success: true,
      status: "resumed",
      executionId: claim.waitState.executionId,
    };
    return resumed;
  },
  (effect) =>
    // The caller holds a resume token, not our confidence, so the cause goes to
    // the log and they get a stated sentence.
    effect.pipe(
      catchStatedSeamFailures(
        resumeLogger,
        "Failed to resume wait",
        "Could not resume this wait"
      )
    )
);
