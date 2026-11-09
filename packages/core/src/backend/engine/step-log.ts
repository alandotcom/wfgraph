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

import type { StepContext } from "#src/backend/extensions/steps/step-handler";
import type { StepResult } from "@wfgraph/shared/actions/step-result";
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
import { runIdempotentDurable } from "#src/backend/engine/durable";

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
  error?: string | undefined;
};

/** Opens the run-log row for a node. */
export function openStepLog(target: {
  store: WorkflowStore;
  context: NodeContext;
  input: unknown;
}): Effect.Effect<WorkflowStepLogHandle, EngineFailure> {
  return target.store
    .startStepLog({
      executionId: target.context.executionId,
      nodeId: target.context.nodeId,
      nodeName: target.context.nodeName,
      nodeType: target.context.nodeType,
      input: target.input,
    })
    .pipe(Effect.mapError(failureFromUnknown));
}

/** The close as the store takes it, with the elapsed the caller measured. */
function writeStepLogClose(
  store: WorkflowStore,
  handle: WorkflowStepLogHandle,
  close: StepLogClose,
  durationMs: number
): Effect.Effect<void, EngineFailure> {
  return store
    .completeStepLog({
      logId: handle.logId,
      durationMs,
      status: close.status,
      output: close.output,
      error: close.error,
    })
    .pipe(Effect.mapError(failureFromUnknown));
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
      // The row is now stuck at `running` and the usual cause is the database
      // itself, so the line names the run rather than only the row: in an outage
      // this is a burst, and a row id can only be resolved against the table that
      // just refused a write.
      Effect.logWarning("Could not close a run-log row").pipe(
        Effect.annotateLogs({
          logId: handle.logId,
          executionId: context.executionId,
          nodeId: context.nodeId,
          nodeName: context.nodeName,
          status: close.status,
          error: Cause.squash(cause),
        })
      )
  );
}

/**
 * Opens a run-log row, runs the work, and closes the row with what it answered.
 *
 * Both halves run on every pass through `runtime.runIdempotent`, which stores
 * no memo row. The handler between them is replayed from the top on every
 * pass, and writing both rows again is safe: the open inserts under an id
 * derived from the run and the node and keeps the first row, and the fenced
 * close applies only where `nodeLogCloseApplies` admits it. The pass's store
 * skips either write when the run's log rows show it would change nothing.
 *
 * The close carries its own status in its step id (`log-close:success` or
 * `log-close:error`), which is the step the Runs view names while that write
 * runs, and the step a failure of that write is counted against.
 *
 * Each attempt times its own work, from the open to the close. A replay reads
 * its work back out of the memo, so the duration it measures is near zero, and
 * the store skips its close unless the row is still `running` because an
 * earlier pass stopped before closing it.
 *
 * The two have opposite failure policies. A refused open fails the node,
 * because nothing has happened yet and the executor's retry of it costs one wasted
 * call. A refused close is swallowed inside its own step, because a run that
 * did its work has not failed because a row could not be closed. The price is a
 * row left open, which the Runs view shows.
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
    // The id carries the node's own id so it survives a rename; the name carries
    // the label, so the trace reads as the graph does.
    const handle = yield* runIdempotentDurable(
      runtime,
      {
        id: `node:${context.nodeId}:log-open`,
        nodeId: context.nodeId,
        name: `${context.nodeName} (open)`,
      },
      openStepLog(target)
    );
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;

    const closeRow = (close: StepLogClose) =>
      runIdempotentDurable(
        runtime,
        {
          id: `node:${context.nodeId}:log-close:${close.status}`,
          nodeId: context.nodeId,
          name: `${context.nodeName} (close)`,
        },
        closeStepLogQuietly(store, context, handle, close, elapsed())
      );

    const result = yield* Effect.matchCauseEffect(Effect.suspend(work), {
      onFailure: (cause) =>
        Effect.gen(function* () {
          const failure = failureFromCause(cause);
          yield* closeRow({ status: "error", error: failure.message });
          return yield* Effect.failCause(cause);
        }),
      onSuccess: Effect.succeed,
    });

    if (result.success) {
      // A success logs its payload. A step reporting success without one has
      // nothing but the envelope to show.
      yield* closeRow({ status: "success", output: result.data ?? result });
    } else {
      yield* closeRow({
        status: "error",
        output: result.error,
        error: result.error.message,
      });
    }

    return result;
  });
}
