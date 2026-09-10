/**
 * Event-mode Wait: park until a matching signal arrives or the timeout fires.
 *
 * A later attempt recompiles its subscriptions and its timeout from the Workflow
 * Version the execution row now names. The timeout is still counted from the
 * instant the first attempt resolved against, so a Migration does not give the
 * run more time than it started with.
 */

import { randomUUID } from "node:crypto";
import type { JsonObject } from "@wfgraph/shared/types/json";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import { resolveWaitUntil } from "@wfgraph/shared/utils/wait-time";
import { Effect } from "effect";
import { DEFAULT_WAIT_TIMEOUT } from "@wfgraph/shared/lifecycle/wait-subscription";
import { closeStepLog } from "#src/backend/engine/step-log";
import { compileWaitSubscriptions } from "#src/backend/engine/wait-match";
import {
  fromStore,
  type WaitAttempt,
  type WaitBranchContext,
  type WaitMode,
  type WaitOutcome,
  type WaitPreparation,
  type WaitResumeInput,
  type WaitWake,
} from "#src/backend/engine/wait-shared";

/** The token addresses a parked run, so it comes from a cryptographic source. */
function generateWaitToken(): string {
  return randomUUID();
}

/**
 * What an event attempt's resume reads back off its own preparation.
 *
 * Everything a resumed run needs is here rather than read from the config
 * again: this crosses a memoized step boundary, so it is what the run parked
 * with, and an edit to the graph cannot reach it. What can reach it is a
 * Migration, which sends the Wait around again and prepares it afresh against
 * the version the run was moved to.
 */
type EventPrepared = {
  resumeToken: string;
  timeoutBehavior: "continue" | "skip";
};

/** What an event attempt's resume step writes into the memo. */
type EventResumed = {
  output: Record<string, unknown>;
  skipOnTimeout: boolean;
};

const prepareEventWait = Effect.fn("prepareEventWait")(function* (
  branch: WaitBranchContext,
  attempt: WaitAttempt
) {
  const { config, store, resolveTemplates, startLog } = branch;

  const failWith = (error: string) =>
    Effect.as(closeStepLog(store, startLog, { status: "error", error }), {
      status: "error" as const,
      error,
    });

  // The timeout is what keeps a parked run mortal, so a wait that names none is
  // held to the default the editor writes rather than parking forever.
  const timeout = config.waitTimeout?.trim() || DEFAULT_WAIT_TIMEOUT;
  const anchorAt = attempt.anchorAt ?? new Date();
  const waitTimeoutResolution = resolveWaitUntil({
    now: anchorAt,
    waitDuration: timeout,
  });
  if (waitTimeoutResolution.error || !waitTimeoutResolution.waitUntil) {
    return yield* failWith(
      waitTimeoutResolution.error ??
        "Wait could not determine a timeout from waitTimeout."
    );
  }

  const compiled = compileWaitSubscriptions({
    subscriptions: config.waitFor ?? [],
    resolveTemplates,
  });
  if (!compiled.valid) {
    return yield* failWith(compiled.error);
  }

  // The token names this park, and a later attempt keeps the one the row already
  // has: everything addressing the parked run keeps addressing it.
  const resumeToken = attempt.resumeToken ?? generateWaitToken();
  const waitUntilIso = encodeIsoTimestamp(waitTimeoutResolution.waitUntil);
  // Read from the config this attempt parks on. A Migration is a decision to
  // adopt the new graph, so the new version's answer to a timeout is the one
  // that holds from here.
  const timeoutBehavior = config.waitTimeoutBehavior ?? "continue";

  const preparation: WaitPreparation<EventPrepared> = {
    status: "ready",
    anchorAtIso: encodeIsoTimestamp(anchorAt),
    park: {
      waitType: "event",
      waitUntilIso,
      subscribedEvents: compiled.subscriptions.map(
        (subscription) => subscription.event
      ),
      resumeToken,
      // Everything here crosses the JSONB column and Inngest's memoization, so a
      // compiled string and a literal are what the match is reduced to.
      metadata: {
        waitTimeout: timeout,
        waitTimeoutBehavior: timeoutBehavior,
        waitFor: compiled.subscriptions,
      },
      timeoutMs: Math.max(
        waitTimeoutResolution.waitUntil.getTime() - Date.now(),
        0
      ),
      // A Cancel Event and a Migration each wake a parked run through the same
      // envelope the resume uses.
      signalTypes: ["wait-resume", "lifecycle-cancel", "version-migrate"],
    },
    prepared: { resumeToken, timeoutBehavior },
  };
  return preparation;
});

/**
 * What the arriving Event carried, and nothing of the envelope it came in.
 *
 * A cancel wake carries no resume payload: the signal is a nudge, and what the
 * canceling Event sent is on the execution row, which the engine reads at this
 * node's boundary. A timeout carries nothing either.
 */
function readArrival(wake: WaitWake): {
  eventName: string | null;
  payload: JsonObject;
} | null {
  return wake.kind === "resume"
    ? { eventName: wake.eventName, payload: wake.payload }
    : null;
}

const resumeEventWait = Effect.fn("resumeEventWait")(function* (
  input: WaitResumeInput<EventPrepared>
) {
  const { branch, prepared, waitStateId, wake, hops } = input;
  const { context, store, workflowId, startLog } = branch;
  const { executionId } = context;

  const timedOut = wake.kind === "timeout";
  const canceled = wake.kind === "cancel";
  const arrival = readArrival(wake);

  yield* fromStore(
    store.markWaitStateStatus({
      waitStateId,
      status: canceled ? "cancelled" : timedOut ? "timed_out" : "resumed",
    })
  );
  yield* fromStore(store.markExecutionRunning({ executionId }));

  yield* fromStore(
    store.recordAuditEvent({
      workflowId,
      executionId,
      eventType: timedOut ? "run_timed_out" : "run_resumed",
      message: timedOut
        ? `Run timed out in event wait node '${context.nodeName}'`
        : canceled
          ? `Run woken by a cancel request in node '${context.nodeName}'`
          : `Run resumed from event in node '${context.nodeName}'`,
      metadata: {
        nodeId: context.nodeId,
        resumeToken: prepared.resumeToken,
        hops,
      },
    })
  );

  // A wait configured to skip on timeout stops its branch instead of letting
  // downstream nodes run without the awaited Event. The behaviour comes off the
  // preparation, which is what this attempt parked with: an edit to the node
  // cannot change how a run already counting down treats its timeout, and a
  // Migration changes it by preparing the next attempt rather than this one.
  const skipOnTimeout = timedOut && prepared.timeoutBehavior === "skip";

  // The resume token stays off this object: it is a capability addressing this
  // parked run, node output is template-addressable, and the panel reads the
  // token off the wait row instead.
  const base = {
    waitType: "event",
    timedOut,
    hops,
    resumedAt: encodeIsoTimestamp(new Date()),
  };
  // `payload.orderId` is the path a builder writes, and the catalog's field list
  // for this node promises exactly that.
  const output = skipOnTimeout
    ? { ...base, skipped: true, skippedReason: "timeout_skip" }
    : {
        ...base,
        ...omitUndefined({
          event: arrival?.eventName ?? undefined,
          payload: arrival === null ? undefined : arrival.payload,
        }),
      };

  yield* closeStepLog(store, startLog, { status: "success", output });

  const resumed: EventResumed = { output, skipOnTimeout };
  return resumed;
});

export const eventWaitMode: WaitMode<EventPrepared, EventResumed> = {
  mode: "event",
  prepare: prepareEventWait,
  resume: resumeEventWait,

  outcome: ({ resumed, wake }): WaitOutcome => {
    const arrival = readArrival(wake);

    // Skip and cancel halt the branch, so the Arriving Event they would name is
    // never read. A timeout that continues names none, which is how an Event
    // Split below this node stops rather than taking a Start Event outlet. A
    // resume names the Event that woke the Wait.
    const canceled = wake.kind === "cancel";
    const arrivingEvent =
      resumed.skipOnTimeout || canceled
        ? undefined
        : arrival === null
          ? null
          : arrival.eventName === null
            ? undefined
            : { eventName: arrival.eventName, payload: arrival.payload };

    // A cancel wake halts the branch as a timeout skip does. The run is claimed,
    // so nothing below this node is work it still wants: a run walking its own
    // graph is sent to the Canceled outlet by the boundary read at this node,
    // which happens before the halt is consulted, and a branch run has no
    // boundary of its own and would otherwise carry on for a run already ending.
    return {
      result: { success: true, data: resumed.output },
      haltBranch: resumed.skipOnTimeout || canceled,
      arrivingEvent,
    };
  },
};
