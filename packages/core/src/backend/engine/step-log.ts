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
import { getErrorMessage } from "@rova/shared/utils";
import type { StepResult } from "@rova/shared/actions/step-result";
import type {
  WorkflowStepLogHandle,
  WorkflowStore,
} from "#src/backend/engine/store";
import type { WorkflowExecutionRuntime } from "#src/backend/engine/runtime";

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
}): Promise<WorkflowStepLogHandle> {
  return target.store.startStepLog({
    executionId: target.context.executionId,
    nodeId: target.context.nodeId,
    nodeName: target.context.nodeName,
    nodeType: target.context.nodeType,
    input: target.input,
  });
}

/**
 * Closes a row `openStepLog` opened. The handle is what carries the row's id and
 * its start time across whatever happened in between, a suspension included.
 */
export function closeStepLog(
  store: WorkflowStore,
  handle: WorkflowStepLogHandle,
  close: StepLogClose
): Promise<void> {
  return store.completeStepLog({
    logId: handle.logId,
    startTime: handle.startTime,
    status: close.status,
    output: close.output,
    error: close.error,
  });
}

/**
 * Closes a row without letting the write's own failure reach the caller.
 *
 * See `runWithStepLog` for why a closing write may not fail a node.
 */
async function closeStepLogQuietly(
  store: WorkflowStore,
  context: NodeContext,
  handle: WorkflowStepLogHandle,
  close: StepLogClose
): Promise<void> {
  try {
    await closeStepLog(store, handle, close);
  } catch (error) {
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
      error,
    });
  }
}

/**
 * Opens a run-log row, runs the work, and closes the row with what it answered.
 *
 * Each write is its own memoized step, and the open one has to be: the handler
 * between them is replayed from the top on every attempt, so an unmemoized open
 * would insert a second row per attempt rather than close the first.
 *
 * The two still have opposite failure policies. A refused open fails the node,
 * since nothing has happened yet and Inngest's retry of it costs one wasted
 * call. A refused close is swallowed, because a run that did its work has not
 * failed because a row could not be closed. The price is a row left open, which
 * the run panel shows.
 */
export async function runWithStepLog<T extends StepResult>(
  target: {
    store: WorkflowStore;
    context: NodeContext;
    runtime: WorkflowExecutionRuntime;
    input: unknown;
  },
  work: () => Promise<T>
): Promise<T> {
  const { store, context, runtime } = target;
  const handle = await runtime.run(`node:${context.nodeId}:log-open`, () =>
    openStepLog(target)
  );

  try {
    const result = await work();

    if (result.success) {
      // A success logs its payload. A step reporting success without one has
      // nothing but the envelope to show.
      await closeOnce(runtime, store, context, handle, {
        status: "success",
        output: result.data ?? result,
      });
    } else {
      await closeOnce(runtime, store, context, handle, {
        status: "error",
        output: result.error,
        error: result.error.message,
      });
    }

    return result;
  } catch (error) {
    await closeOnce(runtime, store, context, handle, {
      status: "error",
      error: getErrorMessage(error),
    });
    throw error;
  }
}

/**
 * Closes the row inside the node's own memoized step, so a replay reuses the
 * write rather than repeating it.
 */
function closeOnce(
  runtime: WorkflowExecutionRuntime,
  store: WorkflowStore,
  context: NodeContext,
  handle: WorkflowStepLogHandle,
  close: StepLogClose
): Promise<void> {
  return runtime.run(`node:${context.nodeId}:log-close`, () =>
    closeStepLogQuietly(store, context, handle, close)
  );
}
