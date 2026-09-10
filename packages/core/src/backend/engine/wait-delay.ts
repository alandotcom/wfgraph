/**
 * Delay-mode Wait: park until a wall-clock target, then resume.
 *
 * The park is a wait on the `workflow/wait.signal` envelope whose timeout is
 * what is left of the delay, so a Migration can reach a sleeping run. Each
 * attempt resolves its target from the instant the first one resolved against,
 * so a Migration changes the target without restarting the clock. A timeout is
 * the ordinary end of the delay.
 *
 * The match admits `version-migrate` alone. A delay wait carries no resume
 * token, so nothing else may wake it through a signal: cancellation reaches it
 * through the function-level `cancelOn` and the sweep the run above it does.
 */

import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import { resolveWaitUntil } from "@wfgraph/shared/utils/wait-time";
import { Effect } from "effect";
import { closeStepLog } from "#src/backend/engine/step-log";
import {
  fromStore,
  readAllowedHoursConfig,
  readWaitGateMode,
  type WaitAttempt,
  type WaitBranchContext,
  type WaitMode,
  type WaitOutcome,
  type WaitPreparation,
  type WaitResumeInput,
} from "#src/backend/engine/wait-shared";

/** What a delay attempt's resume reads back off its own preparation. */
type DelayPrepared = { waitUntilIso: string };

/** What a delay attempt's resume step writes into the memo. */
type DelayResumed = { output: Record<string, unknown>; canceled: boolean };

const prepareDelayWait = Effect.fn("prepareDelayWait")(function* (
  branch: WaitBranchContext,
  attempt: WaitAttempt
) {
  const { config, context, store, startLog } = branch;

  const waitTimezone = config.waitTimezone;
  const waitGateMode = readWaitGateMode(config);
  const anchorAt = attempt.anchorAt ?? new Date();

  const resolved = resolveWaitUntil({
    now: anchorAt,
    waitDuration: config.waitDuration,
    waitUntil: config.waitUntil,
    waitOffset: config.waitOffset,
    waitTimezone,
    ...readAllowedHoursConfig(config),
  });

  if (!resolved.waitUntil) {
    const errorMessage =
      resolved.error ||
      "Wait could not determine a target timestamp from waitUntil/waitDuration.";
    yield* closeStepLog(store, startLog, {
      status: "error",
      error: errorMessage,
    });
    return { status: "error" as const, error: errorMessage };
  }

  const waitUntilIso = encodeIsoTimestamp(resolved.waitUntil);
  const plannedWaitMs = resolved.waitUntil.getTime() - Date.now();
  const didActuallyWait = plannedWaitMs > 0;

  // Gate mode treats an already-passed target as "nothing to wait for" and
  // stops the branch instead of falling through to a zero-length park. It
  // asks whether this Wait ever waited, so only the first attempt can answer
  // no: a later attempt is reached from a park that was still counting down.
  if (
    attempt.anchorAt === undefined &&
    waitGateMode === "require_actual_wait" &&
    !didActuallyWait
  ) {
    const output = {
      waitType: "delay",
      waitUntil: waitUntilIso,
      waitGateMode,
      skipped: true,
      skippedReason: "past_due_no_wait",
      plannedWaitMs,
      didActuallyWait,
      hops: 0,
      resumedAt: encodeIsoTimestamp(new Date()),
    };

    yield* fromStore(
      store.recordAuditEvent({
        workflowId: branch.workflowId,
        executionId: context.executionId,
        eventType: "run_skipped",
        message: `Skipped delay branch in node '${context.nodeName}' (target already passed)`,
        metadata: {
          nodeId: context.nodeId,
          waitType: "delay",
          waitUntil: waitUntilIso,
          plannedWaitMs,
          reason: "past_due_no_wait",
        },
      })
    );

    yield* closeStepLog(store, startLog, { status: "success", output });

    return { status: "skipped" as const, output };
  }

  const preparation: WaitPreparation<DelayPrepared> = {
    status: "ready",
    anchorAtIso: encodeIsoTimestamp(anchorAt),
    park: {
      waitType: "delay",
      waitUntilIso,
      subscribedEvents: [],
      resumeToken: null,
      // Everything a later attempt needs beside the columns the row already has.
      metadata: { waitGateMode, waitTimezone: waitTimezone ?? null },
      timeoutMs: plannedWaitMs,
      signalTypes: ["version-migrate"],
    },
    prepared: { waitUntilIso },
  };
  return preparation;
});

const resumeDelayWait = Effect.fn("resumeDelayWait")(function* (
  input: WaitResumeInput<DelayPrepared>
) {
  const { branch, prepared, wake, hops } = input;
  const { store, startLog } = branch;

  // A delay park answers no cancel signal. This wake reaches it only through a
  // row a Cancel Event claimed while the run was between two parks.
  const canceled = wake.kind === "cancel";

  const output = {
    waitType: "delay",
    waitUntil: prepared.waitUntilIso,
    hops,
    resumedAt: encodeIsoTimestamp(new Date()),
  };

  yield* closeStepLog(store, startLog, { status: "success", output });

  const resumed: DelayResumed = { output, canceled };
  return resumed;
});

export const delayWaitMode: WaitMode<DelayPrepared, DelayResumed> = {
  mode: "delay",
  prepare: prepareDelayWait,
  resume: resumeDelayWait,
  // A cancel wake halts the branch because the run has been claimed. An Event
  // arrival can reach this mode after a Migration and replaces the Arriving Event.
  outcome: ({ resumed, wake }): WaitOutcome => ({
    result: { success: true, data: resumed.output },
    haltBranch: resumed.canceled,
    arrivingEvent:
      wake.kind === "resume" && wake.eventName !== null
        ? { eventName: wake.eventName, payload: wake.payload }
        : undefined,
  }),
};
