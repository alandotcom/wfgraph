/**
 * Event-mode Wait: park until a matching signal arrives or the timeout fires.
 */

import { randomUUID } from "node:crypto";
import { type JsonObject, readJsonObject } from "@wfgraph/shared/types/json";
import { encodeIsoTimestamp } from "@wfgraph/shared/types/timestamp";
import { resolveWaitUntil } from "@wfgraph/shared/utils/wait-time";
import { celStringLiteral } from "@wfgraph/shared/conditions/cel-string-literal";
import { Effect } from "effect";
import { DEFAULT_WAIT_TIMEOUT } from "@wfgraph/shared/lifecycle/wait-subscription";
import { closeStepLog } from "#src/backend/engine/step-log";
import { compileWaitSubscriptions } from "#src/backend/engine/wait-match";
import { fromUnknownPromise, runDurable } from "#src/backend/engine/durable";
import {
  failureFromCause,
  type EngineFailure,
} from "#src/backend/engine/engine-failure";
import {
  fromStore,
  type WaitBranchContext,
  type WaitOutcome,
} from "#src/backend/engine/wait-shared";

/** The token addresses a parked run, so it comes from a cryptographic source. */
function generateWaitToken(): string {
  return randomUUID();
}

/**
 * The `workflow/wait.signal` body out of the Inngest event that carried it.
 *
 * `waitForEvent` resolves to the whole event object, and the signal is WfGraph's
 * own envelope inside it. Reading it once here is what keeps that envelope out
 * of everything below: a builder addresses the Event's payload, not the
 * transport it travelled in.
 */
function readWaitSignal(resumeEvent: unknown) {
  return readJsonObject(readJsonObject(resumeEvent)?.data);
}

/**
 * Which Event woke a parked run, off the signal envelope `sendWaitSignal` built,
 * and `null` for an envelope that named none.
 *
 * A wait subscribes to several Events at once, and this is the only thing that
 * says which of them arrived. The caller decides what an unnamed one means: the
 * node's output leaves the field out rather than carrying a null, since the
 * catalog offers it as a string a condition can compare.
 */
function readWaitEventName(signal: JsonObject | null): string | null {
  const eventType = signal?.eventType;
  return typeof eventType === "string" ? eventType : null;
}

/**
 * Outcome of the persistence work that happens before an event wait suspends the
 * run. Everything a resumed run needs is here rather than read from the config
 * again: this crosses a memoized step boundary, so it is what the run parked
 * with, and a graph edited while the run was parked cannot reach it.
 */
type EventWaitPreparation =
  | { status: "error"; error: string }
  | {
      status: "ready";
      waitStateId: string;
      resumeToken: string;
      timeoutMs?: number;
      timeoutBehavior: "continue" | "skip";
    };

function prepareEventWait(
  branch: WaitBranchContext
): Effect.Effect<EventWaitPreparation, EngineFailure> {
  return Effect.gen(function* () {
    const {
      config,
      context,
      store,
      workflowId,
      runId,
      resolveTemplates,
      startLog,
    } = branch;
    const { executionId } = context;

    const failWith = (
      error: string
    ): Effect.Effect<EventWaitPreparation, EngineFailure> =>
      Effect.as(closeStepLog(store, startLog, { status: "error", error }), {
        status: "error" as const,
        error,
      });

    // The timeout is what keeps a parked run mortal, so a wait that names none is
    // held to the default the editor writes rather than parking forever.
    const timeout = config.waitTimeout?.trim() || DEFAULT_WAIT_TIMEOUT;
    const waitTimeoutResolution = resolveWaitUntil({ waitDuration: timeout });
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

    const resumeToken = generateWaitToken();
    const waitUntilIso = encodeIsoTimestamp(waitTimeoutResolution.waitUntil);
    const timeoutBehavior = config.waitTimeoutBehavior ?? "continue";

    const waitState = yield* fromStore(
      store.createWaitState({
        executionId,
        workflowId,
        runId,
        nodeId: context.nodeId,
        nodeName: context.nodeName,
        waitType: "event",
        resumeToken,
        waitUntilIso,
        subscribedEvents: compiled.subscriptions.map(
          (subscription) => subscription.event
        ),
        // Everything here crosses the JSONB column and Inngest's memoization, so a
        // compiled string and a literal are what the match is reduced to.
        metadata: {
          waitTimeout: timeout,
          waitTimeoutBehavior: timeoutBehavior,
          waitFor: compiled.subscriptions,
        },
      })
    );

    if (!waitState) {
      // A policy cancel flipped the execution terminal between the last step
      // and this park; Inngest is already killing the run.
      return yield* failWith(
        "Execution was cancelled before the wait was registered"
      );
    }

    yield* fromStore(
      store.recordAuditEvent({
        workflowId,
        executionId,
        eventType: "run_waiting",
        message: `Run waiting on event in node '${context.nodeName}'`,
        metadata: {
          nodeId: context.nodeId,
          resumeToken,
          waitFor: compiled.subscriptions.map(
            (subscription) => subscription.event
          ),
          timeoutAt: waitUntilIso,
        },
      })
    );

    return {
      status: "ready",
      waitStateId: waitState.waitStateId,
      resumeToken,
      timeoutMs: Math.max(
        waitTimeoutResolution.waitUntil.getTime() - Date.now(),
        0
      ),
      timeoutBehavior,
    };
  });
}

export function executeEventWait(
  branch: WaitBranchContext
): Effect.Effect<WaitOutcome, EngineFailure> {
  return Effect.gen(function* () {
    const { context, runtime, store, workflowId, startLog } = branch;
    const { executionId } = context;

    const prepared = yield* runDurable(
      runtime,
      `wait-event-prepare-${context.nodeId}`,
      prepareEventWait(branch)
    );

    if (prepared.status === "error") {
      return {
        result: {
          success: false,
          error: { kind: "failure", message: prepared.error },
        },
        haltBranch: false,
      };
    }

    const resumeEvent = yield* Effect.catchCause(
      fromUnknownPromise(() =>
        // Inngest waits on WfGraph's own signal envelope rather than on the
        // business Event: WfGraph decides which runs an arrival concerns first.
        runtime.waitForEvent(`wait-event-${context.nodeId}`, {
          event: "workflow/wait.signal",
          timeoutMs: prepared.timeoutMs,
          ifExpression: [
            "async.data.executionId == event.data.executionId",
            `async.data.nodeId == ${celStringLiteral(context.nodeId)}`,
            `async.data.token == ${celStringLiteral(prepared.resumeToken)}`,
            // A Cancel Event wakes a parked run through the same envelope.
            `(async.data.signalType == ${celStringLiteral("wait-resume")} || async.data.signalType == ${celStringLiteral("lifecycle-cancel")})`,
          ].join(" && "),
        })
      ),
      (cause) =>
        Effect.gen(function* () {
          // The run is unwinding, so no new durable step is started.
          yield* closeStepLog(store, startLog, {
            status: "error",
            error: failureFromCause(cause).message,
          });
          return yield* Effect.failCause(cause);
        })
    );

    const timedOut = resumeEvent === null;
    const signal = readWaitSignal(resumeEvent);

    // Derived outside the step for the same reason `timedOut` is: both come off
    // the memoized `waitForEvent` result, so a replay reads the same verdict.
    const canceled = !timedOut && signal?.signalType === "lifecycle-cancel";
    const resumeEventName = readWaitEventName(signal);

    const resumed = yield* runDurable(
      runtime,
      `wait-event-resume-${context.nodeId}`,
      Effect.gen(function* () {
        yield* fromStore(
          store.markWaitStateStatus({
            waitStateId: prepared.waitStateId,
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
            },
          })
        );

        // A wait configured to skip on timeout stops its branch instead of letting
        // downstream nodes run without the awaited Event. The behaviour comes off
        // the preparation, which is what this run parked with: a wait can outlive
        // several edits to the node it parked on, and none of them may change how
        // this run treats a timeout it is already counting down.
        const skipOnTimeout = timedOut && prepared.timeoutBehavior === "skip";

        // The resume token stays off this object: it is a capability addressing
        // this parked run, node output is template-addressable, and the panel
        // reads the token off the wait row instead.
        const base = {
          waitType: "event",
          timedOut,
          resumedAt: encodeIsoTimestamp(new Date()),
        };
        // A cancel wake carries no resume payload: the signal is a nudge, and what
        // the canceling Event sent is on the execution row, which the engine reads
        // at this node's boundary.
        const carriesPayload = !(timedOut || canceled);
        // What the arriving Event carried, and nothing of the envelope it came in:
        // `payload.orderId` is the path a builder writes, and the catalog's field
        // list for this node promises exactly that.
        const output = skipOnTimeout
          ? { ...base, skipped: true, skippedReason: "timeout_skip" }
          : {
              ...base,
              ...(carriesPayload
                ? {
                    ...(resumeEventName === null
                      ? {}
                      : { event: resumeEventName }),
                    payload: readJsonObject(signal?.payload) ?? {},
                  }
                : {}),
            };

        yield* closeStepLog(store, startLog, { status: "success", output });

        return { output, skipOnTimeout };
      })
    );

    // A cancel wake halts the branch as a timeout skip does. The run is claimed,
    // so nothing below this node is work it still wants: a run walking its own
    // graph is sent to the Canceled outlet by the boundary read at this node,
    // which happens before the halt is consulted, and a branch run has no boundary
    // of its own and would otherwise carry on for a run already ending.
    return {
      result: { success: true, data: resumed.output },
      haltBranch: resumed.skipOnTimeout || canceled,
    };
  });
}
