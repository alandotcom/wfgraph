/**
 * Continue now: a person ends one Wait of a draft run before its time, and the
 * run goes on as if the time had come. Only a draft run takes it, because a run
 * of the published graph keeps the timing its builder published. The park takes
 * the `timeout` wake the executor writes when a deadline passes, so a delay
 * Wait reads it as its target reached and an event Wait as its timeout.
 */

import { Effect } from "effect";
import { IN_FLIGHT_EXECUTION_STATUSES } from "@wfgraph/shared/lifecycle/execution-contracts";
import { AppLogger } from "#src/backend/lib/effect/app-logger";
import {
  Conflict,
  InvalidInput,
  NotFound,
} from "#src/backend/lib/effect/failures";
import { catchSeamFailures } from "#src/backend/lib/effect/internal-failure";
import { annotateServiceSpan } from "#src/backend/lib/telemetry";
import { ExecutionDriver } from "#src/backend/services/executions/driver";
import { ExecutionRepo } from "#src/backend/services/executions/repo";

type ContinueWaitSuccess = {
  success: true;
  status: "continued";
  executionId: string;
};

/** This module's logger, as the Effect that produces it (see `cancel.ts`). */
const continueLogger = Effect.map(AppLogger, (appLogger) =>
  appLogger.get("continue-wait")
);

/** The answer for a park that left `waiting` before this call reached it. */
const noLongerWaiting = new Conflict({
  error: "This Wait is no longer waiting",
});

export const continueWaitNow = Effect.fn("wfgraph.execution.continue_wait")(
  function* (input: { executionId: string; waitStateId: string }) {
    const { executionId, waitStateId } = input;
    const repo = yield* ExecutionRepo;
    const driver = yield* ExecutionDriver;
    const logger = (yield* continueLogger).with({ executionId, waitStateId });
    yield* annotateServiceSpan({ executionId });

    const execution = yield* repo.findSummaryById(executionId);
    if (execution === null) {
      yield* logger.warn("Execution not found for Continue now");
      return yield* new NotFound({ error: "Execution not found" });
    }
    yield* annotateServiceSpan({ workflowId: execution.workflowId });

    if (execution.versionKind !== "draft_snapshot") {
      yield* annotateServiceSpan({ outcome: "published_run" });
      return yield* new InvalidInput({
        error: "Continue now is only for a run of the draft",
      });
    }

    const inFlight = IN_FLIGHT_EXECUTION_STATUSES.some(
      (status) => status === execution.status
    );
    if (!inFlight) {
      yield* annotateServiceSpan({ outcome: "already_finished" });
      return yield* new Conflict({ error: "Execution has already finished" });
    }

    const waits = yield* repo.listWaitingStates(executionId);
    const wait = waits.find((candidate) => candidate.id === waitStateId);
    if (wait === undefined) {
      yield* annotateServiceSpan({ outcome: "not_waiting" });
      return yield* noLongerWaiting;
    }
    // A delay Wait's target and an event Wait's timeout both fill `waitUntil`.
    // A park with neither has no time for Continue now to bring forward.
    if (wait.waitUntil === null) {
      yield* annotateServiceSpan({ outcome: "untimed" });
      return yield* new InvalidInput({
        error: "This Wait has no time to end early",
      });
    }

    // The write takes only a park still `waiting`, so an Event, a Cancel or the
    // deadline that resolved it after the read above wins, and this answers so.
    const resolution = yield* driver.endParkNow({ executionId, waitStateId });
    if (!resolution.resolved) {
      yield* annotateServiceSpan({ outcome: "not_waiting" });
      return yield* noLongerWaiting;
    }

    // The run's next pass records how the Wait ended, in the words it uses for
    // any timeout. This entry is what tells a reader a person brought it forward.
    yield* repo.recordAuditEvent({
      workflowId: execution.workflowId,
      executionId,
      eventType: "run_resumed",
      message: `Continue now ended the wait in node '${wait.nodeName}' before its time`,
      metadata: { nodeId: wait.nodeId, continuedNow: true },
    });
    yield* annotateServiceSpan({ outcome: "continued" });

    const continued: ContinueWaitSuccess = {
      success: true,
      status: "continued",
      executionId,
    };
    return continued;
  },
  (effect) =>
    effect.pipe(
      catchSeamFailures(
        continueLogger,
        "Failed to continue the wait",
        "Could not continue this wait"
      )
    )
);
