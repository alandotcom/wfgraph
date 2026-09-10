import { Effect } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

type WaitWakeTarget =
  | { kind: "resume_token"; token: string }
  | { kind: "wait_state"; waitStateId: string; token: string };

type WaitWakeSource =
  | { kind: "manual"; payload: JsonObject }
  | { kind: "event"; eventName: string; payload: JsonObject };

/**
 * Claims one Wait and delivers its wake to the durable runtime.
 *
 * The claim is released when the durable runtime refuses the signal. Once the
 * signal lands, this module settles that exact fenced claim. The resumed engine
 * owns the Execution's running status and timeline entry because it knows the
 * wake was consumed.
 */
export const wakeWait = Effect.fn("wakeWait")(function* (input: {
  target: WaitWakeTarget;
  source: WaitWakeSource;
}) {
  const repo = yield* ExecutionRepo;
  const inngest = yield* InngestClient;
  const logger = (yield* AppLogger).get("wait-resume");

  const arrival =
    input.source.kind === "event"
      ? {
          signalType: "wait-resume" as const,
          eventName: input.source.eventName,
          payload: input.source.payload,
        }
      : {
          signalType: "wait-resume" as const,
          eventName: null,
          payload: input.source.payload,
        };
  const claim = yield* input.target.kind === "resume_token"
    ? repo.claimWaitingStateByToken({
        resumeToken: input.target.token,
        arrival,
      })
    : repo.claimWaitingStateById({
        waitStateId: input.target.waitStateId,
        arrival,
      });

  if (!claim) {
    return { status: "unchanged" } as const;
  }

  const { waitState, claimedAt } = claim;
  const token = input.target.token;
  const signal =
    input.source.kind === "event"
      ? {
          executionId: waitState.executionId,
          nodeId: waitState.nodeId,
          token,
          eventType: input.source.eventName,
          payload: input.source.payload,
          signalType: "wait-resume" as const,
        }
      : {
          executionId: waitState.executionId,
          nodeId: waitState.nodeId,
          token,
          payload: input.source.payload,
          signalType: "wait-resume" as const,
        };

  yield* inngest.sendWaitSignal(signal).pipe(
    Effect.tapError(() =>
      repo
        .releaseWaitingStateClaim({ waitStateId: waitState.id, claimedAt })
        .pipe(
          Effect.flatMap((released) =>
            released
              ? Effect.void
              : logger.error("Failed to release refused wait wake claim", {
                  waitStateId: waitState.id,
                  executionId: waitState.executionId,
                })
          ),
          Effect.catchTag("DatabaseError", (failure) =>
            logger.error("Failed to release refused wait wake claim", {
              waitStateId: waitState.id,
              executionId: waitState.executionId,
              error: failure.cause,
            })
          )
        )
    )
  );

  const settled = yield* repo.settleWaitingStateClaim({
    waitStateId: waitState.id,
    claimedAt,
  });
  if (!settled) {
    yield* logger.warn("Wait wake claim was already settled", {
      waitStateId: waitState.id,
      executionId: waitState.executionId,
    });
    return { status: "unchanged" } as const;
  }

  return {
    status: "resumed",
    executionId: waitState.executionId,
  } as const;
});
