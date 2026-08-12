import { Effect } from "effect";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { statedSeamFailureHandlers } from "#src/backend/lib/effect/internal-failure";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { NotFound } from "#src/backend/lib/effect/failures";
import { validateApiKey } from "#src/backend/services/api-keys/auth";
import { ExecutionRepo } from "#src/backend/services/executions/repo";
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
 * never arrive. Two callers reach it, and each gates its own way in -- the machine
 * route on an API key, the runs panel on the session it already holds.
 */
export const resumeWaitByToken = Effect.fn("resumeWaitByToken")(
  function* (input: { token: string; body: JsonObject; source: string }) {
    const { token, body } = input;
    const repo = yield* ExecutionRepo;
    const inngest = yield* InngestClient;
    const logger = yield* resumeLogger;

    // Claim before sending. The guarded update is the one winner across every
    // app process, so two callers can never both wake the same parked run.
    const claim = yield* repo.claimWaitingStateByToken(token);

    if (!claim) {
      yield* logger.warn("Wait not found or no longer active");
      return yield* new NotFound({
        error: "Wait not found or no longer active",
      });
    }
    const { waitState, claimedAt } = claim;

    yield* inngest
      .sendWaitSignal({
        executionId: waitState.executionId,
        nodeId: waitState.nodeId,
        token,
        payload: body,
        signalType: "wait-resume",
      })
      .pipe(
        Effect.tapError(() =>
          repo
            .releaseWaitingStateClaim({ waitStateId: waitState.id, claimedAt })
            .pipe(
              Effect.flatMap((released) =>
                released
                  ? Effect.void
                  : logger.error(
                      "Failed to release refused wait-resume claim",
                      {
                        waitStateId: waitState.id,
                      }
                    )
              ),
              Effect.catchTag("DatabaseError", (releaseFailure) =>
                logger.error("Failed to release refused wait-resume claim", {
                  waitStateId: waitState.id,
                  error: releaseFailure.cause,
                })
              )
            )
        )
      );

    const completedClaim = yield* repo.settleWaitingStateClaim({
      waitStateId: waitState.id,
      claimedAt,
    });
    if (!completedClaim) {
      yield* logger.warn("Wait resume claim was already settled", {
        waitStateId: waitState.id,
      });
    }

    yield* repo.markRunning(waitState.executionId);

    yield* repo.recordAuditEvent({
      workflowId: waitState.workflowId,
      executionId: waitState.executionId,
      eventType: "run_resumed",
      message: `Run resumed from ${input.source}`,
      metadata: {
        waitStateId: waitState.id,
      },
    });

    const resumed: WorkflowResumeSuccess = {
      success: true,
      status: "resumed",
      executionId: waitState.executionId,
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

/**
 * The machine route's resume: an API key, then the token.
 *
 * Credentials before the lookup. A wait token
 * travels in a URL and so accumulates in browser history, proxy logs, and
 * referrers; answering "not found" versus "unauthorized" to a caller who has one
 * but no API key tells them whether that token is still live.
 */
export const postWorkflowResume = Effect.fn("postWorkflowResume")(
  function* (input: {
    token: string;
    body: JsonObject;
    authHeader: string | null;
  }) {
    yield* validateApiKey(input.authHeader).pipe(
      Effect.tapError((failure) =>
        Effect.andThen(resumeLogger, (logger) =>
          logger.warn("Workflow resume rejected due to invalid API key", {
            reason: failure.payload.error,
          })
        )
      )
    );

    return yield* resumeWaitByToken({
      token: input.token,
      body: input.body,
      source: "the resume endpoint",
    });
  }
);
