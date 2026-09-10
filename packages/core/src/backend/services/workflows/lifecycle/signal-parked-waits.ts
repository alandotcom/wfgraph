/**
 * Wait signals for the Waits of one Execution that are still parked.
 *
 * A Cancel Event and an Exit claim each end a run's work while branches of it
 * may be parked, and a parked branch reaches no node boundary until a signal
 * wakes it. Both paths send those signals through `signalParkedWaits`.
 */

import { Effect, Result } from "effect";
import type { WaitSignalType } from "@wfgraph/shared/lifecycle/wait-signal";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { DEFAULT_QUERY_CONNECTIONS } from "#src/backend/lib/db/config";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import { InngestClient } from "#src/backend/lib/effect/inngest-client";
import {
  ExecutionRepo,
  type WorkflowWaitState,
} from "#src/backend/services/executions/repo";

/**
 * Sends one wait signal to each parked Wait, addressed by its node id and token.
 *
 * Every send is attempted before this answers, so one refused send does not
 * keep the other Waits parked. When any send was refused, this fails with the
 * first refusal. It writes no log record, because the caller owns the one
 * record for its unit of work.
 */
export const signalParkedWaits = Effect.fn("signalParkedWaits")(
  function* (input: {
    executionId: string;
    parked: readonly WorkflowWaitState[];
    signalType: WaitSignalType;
    /** The Event that caused the signal, which a Cancel Event names. */
    eventName?: string | undefined;
    /** What that Event carried. */
    payload?: JsonObject | undefined;
  }) {
    const inngest = yield* InngestClient;

    const sent = yield* Effect.forEach(
      input.parked,
      (waitState) =>
        Effect.result(
          inngest.sendWaitSignal(
            omitUndefined({
              executionId: input.executionId,
              nodeId: waitState.nodeId,
              token: waitState.resumeToken,
              eventType: input.eventName,
              payload: input.payload,
              signalType: input.signalType,
            })
          )
        ),
      { concurrency: DEFAULT_QUERY_CONNECTIONS }
    );

    // Every send has settled by now, so this only reports the first refusal.
    yield* Effect.forEach(sent, (outcome) =>
      Result.isFailure(outcome) ? Effect.fail(outcome.failure) : Effect.void
    );
  }
);

/**
 * Wakes every Wait of an Execution still parked after an Exit claim, which is
 * how the run that won the claim ends the sibling branches parked beside it.
 *
 * The Waits of the winning run and of the runs that started it have already
 * resumed, so the read never names them. A refused send fails this after every
 * send was tried, and the durable step that runs it retries it.
 */
export const wakeParkedWaitsAfterExit = Effect.fn("wakeParkedWaitsAfterExit")(
  function* (input: { executionId: string }) {
    const repo = yield* ExecutionRepo;
    const logger = (yield* AppLogger).get("lifecycle-exit");

    const parked = yield* repo.listWaitingStates(input.executionId);
    yield* signalParkedWaits({
      executionId: input.executionId,
      parked,
      signalType: "lifecycle-exit",
    });

    yield* logger.info("Woke the parked Waits of an exited run", {
      run: { executionId: input.executionId },
      outcome: { parkedWaits: parked.length },
    });
  }
);
