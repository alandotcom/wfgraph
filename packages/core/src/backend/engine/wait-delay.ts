/**
 * Delay-mode Wait: park until a wall-clock target, then resume.
 */

import { encodeIsoTimestamp } from "@rova/shared/types/timestamp";
import { resolveWaitUntil } from "@rova/shared/utils/wait-time";
import { Effect } from "effect";
import { closeStepLog } from "#src/backend/engine/step-log";
import { fromUnknownPromise, runDurable } from "#src/backend/engine/durable";
import {
  failureFromCause,
  type EngineFailure,
} from "#src/backend/engine/engine-failure";
import {
  fromStore,
  readAllowedHoursConfig,
  readWaitGateMode,
  type WaitBranchContext,
  type WaitOutcome,
} from "#src/backend/engine/wait-shared";

/**
 * Outcome of the persistence work that happens before a delay wait suspends
 * the run. Crosses a step boundary, so every field is JSON-safe.
 */
type DelayWaitPreparation =
  | { status: "error"; error: string }
  | { status: "skipped"; output: Record<string, unknown> }
  | {
      status: "ready";
      waitStateId: string;
      waitUntilIso: string;
      plannedWaitMs: number;
    };

function prepareDelayWait(
  branch: WaitBranchContext
): Effect.Effect<DelayWaitPreparation, EngineFailure> {
  return Effect.gen(function* () {
    const { config, context, store, workflowId, runId, startLog } = branch;
    const { executionId } = context;

    const waitTimezone = config.waitTimezone;
    const waitGateMode = readWaitGateMode(config);

    const resolved = resolveWaitUntil({
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
      return { status: "error", error: errorMessage };
    }

    const waitUntilIso = encodeIsoTimestamp(resolved.waitUntil);
    const plannedWaitMs = resolved.waitUntil.getTime() - Date.now();
    const didActuallyWait = plannedWaitMs > 0;

    // Gate mode treats an already-passed target as "nothing to wait for" and
    // stops the branch instead of falling through to a zero-length sleep.
    if (waitGateMode === "require_actual_wait" && !didActuallyWait) {
      const output = {
        waitType: "delay",
        waitUntil: waitUntilIso,
        waitGateMode,
        skipped: true,
        skippedReason: "past_due_no_wait",
        plannedWaitMs,
        didActuallyWait,
        resumedAt: encodeIsoTimestamp(new Date()),
      };

      yield* fromStore(
        store.recordAuditEvent({
          workflowId,
          executionId,
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

      return { status: "skipped", output };
    }

    const waitState = yield* fromStore(
      store.createWaitState({
        executionId,
        workflowId,
        runId,
        nodeId: context.nodeId,
        nodeName: context.nodeName,
        waitType: "delay",
        waitUntilIso,
        metadata: {
          waitGateMode,
          waitTimezone,
        },
      })
    );

    if (!waitState) {
      // A policy cancel flipped the execution terminal between the last step
      // and this park; Inngest is already killing the run.
      const cancelledMessage =
        "Execution was cancelled before the wait was registered";
      yield* closeStepLog(store, startLog, {
        status: "error",
        error: cancelledMessage,
      });
      return { status: "error", error: cancelledMessage };
    }

    yield* fromStore(
      store.recordAuditEvent({
        workflowId,
        executionId,
        eventType: "run_waiting",
        message: `Run waiting in delay node '${context.nodeName}'`,
        metadata: {
          nodeId: context.nodeId,
          waitType: "delay",
          waitUntil: waitUntilIso,
          waitGateMode,
        },
      })
    );

    return {
      status: "ready",
      waitStateId: waitState.waitStateId,
      waitUntilIso,
      plannedWaitMs,
    };
  });
}

export function executeDelayWait(
  branch: WaitBranchContext
): Effect.Effect<WaitOutcome, EngineFailure> {
  return Effect.gen(function* () {
    const { context, runtime, store, workflowId, startLog } = branch;
    const { executionId } = context;

    // Everything before the sleep is one durable step: a replay must not resolve
    // a fresh target time or insert a second wait-state row.
    const prepared = yield* runDurable(
      runtime,
      `wait-delay-prepare-${context.nodeId}`,
      prepareDelayWait(branch)
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

    if (prepared.status === "skipped") {
      return {
        result: { success: true, data: prepared.output },
        haltBranch: true,
      };
    }

    yield* Effect.catchCause(
      fromUnknownPromise(() =>
        runtime.sleep(
          `wait-delay-${context.nodeId}`,
          Math.max(prepared.plannedWaitMs, 0)
        )
      ),
      (cause) =>
        Effect.gen(function* () {
          // Failure here means the run is unwinding (cancellation surfaces this
          // way), so the closing row is written directly rather than as a step.
          yield* closeStepLog(store, startLog, {
            status: "error",
            error: failureFromCause(cause).message,
          });
          return yield* Effect.failCause(cause);
        })
    );

    const output = yield* runDurable(
      runtime,
      `wait-delay-resume-${context.nodeId}`,
      Effect.gen(function* () {
        yield* fromStore(
          store.markWaitStateStatus({
            waitStateId: prepared.waitStateId,
            status: "resumed",
          })
        );
        yield* fromStore(store.markExecutionRunning({ executionId }));

        yield* fromStore(
          store.recordAuditEvent({
            workflowId,
            executionId,
            eventType: "run_resumed",
            message: `Run resumed after delay in node '${context.nodeName}'`,
            metadata: {
              nodeId: context.nodeId,
            },
          })
        );

        const resumeOutput = {
          waitType: "delay",
          waitUntil: prepared.waitUntilIso,
          resumedAt: encodeIsoTimestamp(new Date()),
        };

        yield* closeStepLog(store, startLog, {
          status: "success",
          output: resumeOutput,
        });

        return resumeOutput;
      })
    );

    return { result: { success: true, data: output }, haltBranch: false };
  });
}
