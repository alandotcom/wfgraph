import { Effect } from "effect";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

/**
 * Which parked Wait the wake addresses.
 *
 * A manual resume from the runs panel names the park's own token. An Event
 * delivery names the row it selected and the Event it is delivering, which the
 * claim requires the row to still be subscribed to: a Migration can re-park the
 * row between the selection and the claim.
 */
type WaitWakeTarget =
  | { kind: "resume_token"; token: string }
  | {
      kind: "wait_state";
      waitStateId: string;
      token: string;
      eventName: string;
    };

/**
 * How far a wake got.
 *
 * `unclaimed` is no row this wake could take, so nothing was sent and no run
 * woke. `resumed` is the signal delivered and this caller's claim settled.
 * `raced` is the signal delivered and the claim settled by someone else in the
 * meantime, which is a run that did resume: the wake reached the engine, and
 * only the bookkeeping was lost.
 */
export type WaitWakeOutcome =
  | { status: "unclaimed" }
  | { status: "resumed"; executionId: string }
  | { status: "raced"; executionId: string };

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
  /** What the Event or the runs panel sent, which the woken run reads back. */
  payload: JsonObject;
}) {
  const repo = yield* ExecutionRepo;
  const inngest = yield* InngestClient;
  const logger = (yield* AppLogger).get("wait-resume");

  const { target, payload } = input;
  const eventName = target.kind === "wait_state" ? target.eventName : null;
  const arrival = {
    signalType: "wait-resume" as const,
    eventName,
    payload,
  };
  const claim = yield* target.kind === "resume_token"
    ? repo.claimWaitingStateByToken({
        resumeToken: target.token,
        arrival,
      })
    : repo.claimWaitingStateById({
        waitStateId: target.waitStateId,
        eventName: target.eventName,
        arrival,
      });

  if (!claim) {
    const unclaimed: WaitWakeOutcome = { status: "unclaimed" };
    return unclaimed;
  }

  const { waitState, claimedAt } = claim;
  // The claim outlives the wake whether the row refused the release or the
  // database did. A database failure carries a cause to name; a refusal has
  // none.
  const logReleaseFailure = (error?: unknown) =>
    logger.error(
      "Failed to release refused wait wake claim",
      omitUndefined({
        run: { executionId: waitState.executionId },
        node: { waitStateId: waitState.id },
        error,
      })
    );
  // A manual resume names no Event, and the envelope carries no key for one.
  const signal = omitUndefined({
    executionId: waitState.executionId,
    nodeId: waitState.nodeId,
    token: target.token,
    eventType: eventName ?? undefined,
    payload,
    signalType: "wait-resume" as const,
  });

  yield* inngest.sendWaitSignal(signal).pipe(
    Effect.tapError(() =>
      repo
        .releaseWaitingStateClaim({ waitStateId: waitState.id, claimedAt })
        .pipe(
          Effect.flatMap((released) =>
            released ? Effect.void : logReleaseFailure()
          ),
          Effect.catchTag("DatabaseError", (failure) =>
            logReleaseFailure(failure.cause)
          )
        )
    )
  );

  const settled = yield* repo.settleWaitingStateClaim({
    waitStateId: waitState.id,
    claimedAt,
  });
  if (!settled) {
    // The signal is already with the durable runtime, so the run wakes whatever
    // this write found. Something else settled the row first, which is what
    // separates this from a wake that reached no run at all.
    yield* logger.warn("Wait wake claim was already settled", {
      run: { executionId: waitState.executionId },
      node: { waitStateId: waitState.id },
    });
    const raced: WaitWakeOutcome = {
      status: "raced",
      executionId: waitState.executionId,
    };
    return raced;
  }

  const resumed: WaitWakeOutcome = {
    status: "resumed",
    executionId: waitState.executionId,
  };
  return resumed;
});
