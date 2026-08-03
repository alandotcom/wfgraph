/**
 * The run-log rows the engine writes around a node's work.
 *
 * Every node's rows are opened and closed here rather than inside the step, so a
 * plugin's action, a host's action, the engine's own two, the Condition node and
 * the Wait node all leave the same trace and a step author writes none of it.
 * `runWithStepLog` covers the nodes whose work begins and ends in one call. The
 * Wait opens its row inside a memoized step and closes it from one of many
 * branches on the far side of a suspension, so it uses the two halves directly.
 */

import { getAppLogger } from "#src/backend/lib/logger";
import type { StepContext } from "#src/backend/extensions/steps/step-handler";
import type { StepResult } from "@rova/shared/actions/step-result";
import { Cause, Effect } from "effect";
import type {
  WorkflowStepLogHandle,
  WorkflowStore,
} from "#src/backend/engine/store";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";
import {
  type EngineFailure,
  failureFromCause,
  failureFromUnknown,
} from "#src/backend/engine/engine-failure";

const stepLogLogger = getAppLogger("workflow", "step-log");

/**
 * A `StepContext` as the engine builds one, where the run id is always set.
 *
 * The schema leaves `executionId` optional because a step decodes its own
 * `_context` back out of an input record and a failed decode there costs the
 * whole context. The engine writes the id on every node, and saying so once here
 * is what lets the row below read it off the context rather than be handed the
 * same value a second time.
 */
export type NodeContext = StepContext & { executionId: string };

/** How a row is closed: the status, and whichever of the two payloads applies. */
type StepLogClose = {
  status: "success" | "error";
  output?: unknown;
  error?: string;
};

/** Opens the run-log row for a node. */
export function openStepLog(target: {
  store: WorkflowStore;
  context: NodeContext;
  input: unknown;
}): Effect.Effect<WorkflowStepLogHandle, EngineFailure> {
  return Effect.tryPromise({
    try: () =>
      target.store.startStepLog({
        executionId: target.context.executionId,
        nodeId: target.context.nodeId,
        nodeName: target.context.nodeName,
        nodeType: target.context.nodeType,
        input: target.input,
      }),
    catch: failureFromUnknown,
  });
}

/** The close as the store takes it, with the elapsed the caller measured. */
function writeStepLogClose(
  store: WorkflowStore,
  handle: WorkflowStepLogHandle,
  close: StepLogClose,
  durationMs: number
): Effect.Effect<void, EngineFailure> {
  return Effect.tryPromise({
    try: () =>
      store.completeStepLog({
        logId: handle.logId,
        durationMs,
        status: close.status,
        output: close.output,
        error: close.error,
      }),
    catch: failureFromUnknown,
  });
}

/**
 * Closes a row `openStepLog` opened, timed from the moment the row was opened.
 *
 * That is what a row spanning a suspension measures: the Wait node opens its row
 * on one side of the suspension and closes it on the other, so the duration it
 * means to record is how long the run was parked.
 */
export function closeStepLog(
  store: WorkflowStore,
  handle: WorkflowStepLogHandle,
  close: StepLogClose
): Effect.Effect<void, EngineFailure> {
  return writeStepLogClose(store, handle, close, Date.now() - handle.startTime);
}

/**
 * Closes a row without letting the write's own failure reach the caller.
 *
 * See `runWithStepLog` for why a closing write may not fail a node.
 */
function closeStepLogQuietly(
  store: WorkflowStore,
  context: NodeContext,
  handle: WorkflowStepLogHandle,
  close: StepLogClose,
  durationMs: number
): Effect.Effect<void> {
  return Effect.catchCause(
    writeStepLogClose(store, handle, close, durationMs),
    (cause) =>
      Effect.sync(() => {
        // The row is now stuck at `running` and the usual cause is the database
        // itself, so the line names the run rather than only the row: in an outage
        // this is a burst, and a row id can only be resolved against the table that
        // just refused a write.
        stepLogLogger.warn("Could not close a run-log row", {
          logId: handle.logId,
          executionId: context.executionId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          status: close.status,
          error: Cause.squash(cause),
        });
      })
  );
}

/**
 * Opens a run-log row, runs the work, and closes the row with what it answered.
 *
 * Both halves are memoized steps, which is the difference between an INSERT and
 * an UPDATE by id. The handler between them is replayed from the top on every
 * attempt, so an unmemoized open would insert a second row per attempt rather
 * than close the first.
 *
 * The close carries the attempt in its step id, which is what lets a retry
 * correct a verdict an earlier attempt wrote while a plain replay leaves the row
 * alone. A close memoized under a fixed id would freeze the first verdict; an
 * unmemoized close would rewrite the row on every replay, and each replay reads
 * its work back out of the memo, so the duration it records is near zero.
 *
 * Each attempt times its own work. The handle's start time came out of the memo
 * with the row's id, so a duration taken from it would grow with everything that
 * happened between the two attempts, a wait included.
 *
 * The two have opposite failure policies. A refused open fails the node, since
 * nothing has happened yet and Inngest's retry of it costs one wasted call. A
 * refused close is swallowed inside its own step, because a run that did its
 * work has not failed because a row could not be closed. The price is a row left
 * open, which the run panel shows.
 */
export function runWithStepLog<T extends StepResult, E, R>(
  target: {
    store: WorkflowStore;
    context: NodeContext;
    runtime: WorkflowExecutionRuntime;
    input: unknown;
  },
  work: () => Effect.Effect<T, E, R>
): Effect.Effect<T, E | EngineFailure, R> {
  return Effect.gen(function* () {
    const { store, context, runtime } = target;
    const effectContext = yield* Effect.context<R>();
    const handle = yield* Effect.tryPromise({
      try: () =>
        runtime.run(`node:${context.nodeId}:log-open`, () =>
          Effect.runPromiseWith(effectContext)(openStepLog(target))
        ),
      catch: failureFromUnknown,
    });
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;

    // One attempt closes the row down one path, so the two callers below share an
    // id. The step answers null because a memoized value has to be JSON-safe.
    const closeOnce = (close: StepLogClose) =>
      Effect.tryPromise({
        try: () =>
          runtime.run(
            `node:${context.nodeId}:log-close:${runtime.attempt}`,
            () =>
              Effect.runPromiseWith(effectContext)(
                Effect.as(
                  closeStepLogQuietly(store, context, handle, close, elapsed()),
                  null
                )
              )
          ),
        catch: failureFromUnknown,
      });

    const result = yield* Effect.matchCauseEffect(Effect.suspend(work), {
      onFailure: (cause) =>
        Effect.gen(function* () {
          const failure = failureFromCause(cause);
          yield* closeOnce({ status: "error", error: failure.message });
          return yield* Effect.failCause(cause);
        }),
      onSuccess: Effect.succeed,
    });

    if (result.success) {
      // A success logs its payload. A step reporting success without one has
      // nothing but the envelope to show.
      yield* closeOnce({ status: "success", output: result.data ?? result });
    } else {
      yield* closeOnce({
        status: "error",
        output: result.error,
        error: result.error.message,
      });
    }

    return result;
  });
}
