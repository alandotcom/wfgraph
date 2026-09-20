/**
 * Delay-mode Wait: park until a wall-clock target, then resume.
 *
 * The park is a wait on the `workflow/wait.signal` envelope whose timeout is
 * what is left of the delay, so a Migration can reach a sleeping run. Each
 * attempt resolves its target from the instant the first one resolved against,
 * so a Migration changes the target without restarting the clock. A timeout is
 * the ordinary end of the delay.
 *
 * The match admits `version-migrate` and `lifecycle-exit`. A delay wait carries
 * no resume token, so no Event and no manual resume can wake it. A Cancel Event
 * reaches it through the function-level `cancelOn` and the sweep the run above
 * it does, and an Exit claimed by another branch wakes it through the signal.
 */

import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import {
  applyWaitAllowedHours,
  parsePositiveDurationMs,
  resolveWaitTarget,
} from "@wfgraph/shared/utils/wait-time";
import { Effect } from "effect";
import { closeStepLog } from "#src/backend/engine/step-log";
import {
  fromStore,
  isClaimWake,
  readAllowedHoursConfig,
  readWaitGateMode,
  type WaitAttempt,
  type WaitGateMode,
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

type DelayPlan =
  | { status: "error"; error: string }
  | {
      status: "skipped";
      waitUntilIso: string;
      waitGateMode: WaitGateMode;
      waitMaxLateness?: string | undefined;
      reason: "past_due_beyond_max_lateness" | "past_due_no_wait";
      auditMessage: string;
      plannedWaitMs: number;
      maxLatenessMs?: number | undefined;
    }
  | {
      status: "ready";
      anchorAt: Date;
      waitUntilIso: string;
      waitGateMode: WaitGateMode;
      waitMaxLateness?: string | undefined;
      waitTimezone?: string | undefined;
      plannedWaitMs: number;
    };

function planDelayWait(
  config: WaitBranchContext["config"],
  attempt: WaitAttempt
): DelayPlan {
  const waitTimezone = config.waitTimezone;
  const normalizedWaitTimezone = waitTimezone?.trim() || undefined;
  const waitGateMode = readWaitGateMode(config);
  const anchorAt = attempt.anchorAt ?? new Date();
  const target = resolveWaitTarget({
    now: anchorAt,
    waitDuration: config.waitDuration,
    waitUntil: config.waitUntil,
    waitOffset: config.waitOffset,
    waitTimezone: normalizedWaitTimezone,
  });

  if (!target.waitUntil) {
    return {
      status: "error",
      error:
        target.error ||
        "Wait could not determine a target timestamp from waitUntil/waitDuration.",
    };
  }

  const targetIso = encodeIsoTimestamp(target.waitUntil);
  const targetWaitMs = target.waitUntil.getTime() - anchorAt.getTime();
  if (waitGateMode === "max_lateness") {
    const maxLatenessMs = parsePositiveDurationMs(config.waitMaxLateness);
    if (maxLatenessMs === null) {
      return {
        status: "error",
        error:
          "Maximum lateness must be a positive duration such as 30m, 6h, or P1D.",
      };
    }

    // Maximum lateness measures the authored target plus its offset. The
    // allowed-hours window has not shifted that target yet.
    if (attempt.anchorAt === undefined && targetWaitMs < -maxLatenessMs) {
      return {
        status: "skipped",
        waitUntilIso: targetIso,
        waitGateMode,
        waitMaxLateness: config.waitMaxLateness,
        reason: "past_due_beyond_max_lateness",
        auditMessage: "target exceeded maximum lateness",
        plannedWaitMs: targetWaitMs,
        maxLatenessMs,
      };
    }
  }

  const windowResult = applyWaitAllowedHours({
    candidate: target.waitUntil,
    timeZone: normalizedWaitTimezone,
    ...readAllowedHoursConfig(config),
  });
  if (windowResult.error) {
    return { status: "error", error: windowResult.error };
  }

  const waitUntilIso = encodeIsoTimestamp(windowResult.date);
  const plannedWaitMs = windowResult.date.getTime() - Date.now();

  // This gate asks whether the Wait actually parks after allowed hours are
  // applied. Only the first attempt can answer no: a later attempt is reached
  // from a park that was still counting down.
  if (
    attempt.anchorAt === undefined &&
    waitGateMode === "require_actual_wait" &&
    plannedWaitMs <= 0
  ) {
    return {
      status: "skipped",
      waitUntilIso,
      waitGateMode,
      reason: "past_due_no_wait",
      auditMessage: "target already passed",
      plannedWaitMs,
    };
  }

  return {
    status: "ready",
    anchorAt,
    waitUntilIso,
    waitGateMode,
    waitMaxLateness: config.waitMaxLateness,
    waitTimezone,
    plannedWaitMs,
  };
}

const prepareDelayWait = Effect.fn("prepareDelayWait")(function* (
  branch: WaitBranchContext,
  attempt: WaitAttempt
) {
  const { context, store, startLog } = branch;
  const plan = planDelayWait(branch.config, attempt);

  if (plan.status === "error") {
    yield* closeStepLog(store, startLog, {
      status: "error",
      error: plan.error,
    });
    return plan;
  }

  if (plan.status === "skipped") {
    const output = omitUndefined({
      waitType: "delay",
      waitUntil: plan.waitUntilIso,
      waitGateMode: plan.waitGateMode,
      waitMaxLateness: plan.waitMaxLateness,
      skipped: true,
      skippedReason: plan.reason,
      plannedWaitMs: plan.plannedWaitMs,
      didActuallyWait: false,
      hops: 0,
      resumedAt: encodeIsoTimestamp(new Date()),
    });

    yield* fromStore(
      store.recordAuditEvent({
        workflowId: branch.workflowId,
        executionId: context.executionId,
        eventType: "run_skipped",
        message: `Skipped delay branch in node '${context.nodeName}' (${plan.auditMessage})`,
        metadata: omitUndefined({
          nodeId: context.nodeId,
          waitType: "delay",
          waitUntil: plan.waitUntilIso,
          plannedWaitMs: plan.plannedWaitMs,
          maxLatenessMs: plan.maxLatenessMs,
          reason: plan.reason,
        }),
      })
    );

    yield* closeStepLog(store, startLog, { status: "success", output });
    return { status: "skipped" as const, output };
  }

  const preparation: WaitPreparation<DelayPrepared> = {
    status: "ready",
    anchorAtIso: encodeIsoTimestamp(plan.anchorAt),
    park: {
      waitType: "delay",
      waitUntilIso: plan.waitUntilIso,
      subscribedEvents: [],
      resumeToken: null,
      // Everything a later attempt needs beside the columns the row already has.
      metadata: {
        waitGateMode: plan.waitGateMode,
        waitMaxLateness: plan.waitMaxLateness ?? null,
        waitTimezone: plan.waitTimezone ?? null,
      },
      timeoutMs: plan.plannedWaitMs,
      signalTypes: ["version-migrate", "lifecycle-exit"],
    },
    prepared: { waitUntilIso: plan.waitUntilIso },
  };
  return preparation;
});

const resumeDelayWait = Effect.fn("resumeDelayWait")(function* (
  input: WaitResumeInput<DelayPrepared>
) {
  const { branch, prepared, wake, hops } = input;
  const { store, startLog } = branch;

  // A claim wake stops the branch. An Exit reaches a delay park through its
  // signal. A Cancel reaches it only through a row a Cancel Event claimed while
  // the run was between two parks, or through a claim that refused the park.
  const canceled = isClaimWake(wake);

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
  // A Cancel or Exit wake halts the branch because the run has been claimed. An
  // Event arrival can reach this mode after a Migration and replaces the
  // Arriving Event.
  outcome: ({ resumed, wake }): WaitOutcome => ({
    result: { success: true, data: resumed.output },
    haltBranch: resumed.canceled,
    arrivingEvent:
      wake.kind === "resume" && wake.eventName !== null
        ? { eventName: wake.eventName, payload: wake.payload }
        : undefined,
  }),
};
