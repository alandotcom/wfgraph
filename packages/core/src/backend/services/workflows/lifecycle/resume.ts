import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { statedSeamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import { NotFound } from "#src/backend/lib/effect/failures";
import { wakeWait } from "#src/backend/services/workflows/lifecycle/wake-wait";
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
 * never arrive. The runs panel reaches it through its authenticated RPC call.
 */
export const resumeWaitByToken = Effect.fn("resumeWaitByToken")(
  function* (input: { token: string; body: JsonObject }) {
    const result = yield* wakeWait({
      target: { kind: "resume_token", token: input.token },
      payload: input.body,
    });

    // `raced` is a run that resumed on this call's signal and had its claim
    // settled by another writer, so the caller gets the success it earned. Only
    // a wake that claimed nothing is a wait the caller cannot reach.
    if (result.status === "unclaimed") {
      const logger = yield* resumeLogger;
      yield* logger.warn("Wait not found or no longer active");
      return yield* new NotFound({
        error: "Wait not found or no longer active",
      });
    }

    const resumed: WorkflowResumeSuccess = {
      success: true,
      status: "resumed",
      executionId: result.executionId,
    };
    return resumed;
  },
  (effect) =>
    // The caller holds a resume token, not our confidence, so the cause goes to
    // the log and they get a stated sentence.
    effect.pipe(
      Effect.catchTags(
        statedSeamFailureHandlers(
          resumeLogger,
          "Failed to resume wait",
          "Could not resume this wait"
        )
      )
    )
);
